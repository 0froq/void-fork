import { sql as drizzleSql, and, eq, notInArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import { clearCronScheduler } from '../cron-scheduler-client.ts';
import {
  TERMINAL_DEPLOYMENT_STATUSES,
  type Db,
  deleteProjectCascade,
  getAllProjectDeployments,
  getDomainsByProjectId,
  getProject,
  getProjectResources,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  getLegacyProjectWorkerName,
  getProjectDeploymentWorkerName,
  getProjectQueueName,
  getSandboxHostScriptName,
} from '../naming.ts';
import { deployments as deploymentsTable, projects as projectsTable } from '../schema.ts';
import type { Project, Resource } from '../types.ts';
import {
  deleteCustomHostname,
  deleteD1Database,
  deleteHyperdrive,
  deleteKVNamespace,
  deleteQueue,
  deleteR2Bucket,
} from './cloudflare-api.ts';
import { deleteContainerApplicationIdempotent, findContainerApplication } from './containers.ts';
import { sandboxContainerApplicationName } from './sandbox-host.ts';

function deleteCloudflareResource(
  accountId: string,
  apiToken: string,
  resource: Pick<Resource, 'type' | 'cf_id'>,
): Promise<void> {
  const resourceType = resource.type;

  switch (resourceType) {
    case 'd1':
      return deleteD1Database(accountId, apiToken, resource.cf_id);
    case 'kv':
      return deleteKVNamespace(accountId, apiToken, resource.cf_id);
    case 'r2':
      return deleteR2Bucket(accountId, apiToken, resource.cf_id);
    case 'queue':
      return deleteQueue(accountId, apiToken, resource.cf_id);
    case 'hyperdrive':
      return deleteHyperdrive(accountId, apiToken, resource.cf_id);
    case 'container':
      return deleteContainerApplicationIdempotent(accountId, apiToken, resource.cf_id);
    default:
      resourceType satisfies never;
      throw new Error(`Unsupported resource type: ${resourceType}`);
  }
}

/**
 * DELETE the project's sandbox host worker script in the dispatch namespace.
 * Treats 404 as success. Throws on any other non-OK response.
 *
 * The host script is the cross-script DO host (`do-host-${slug}`). Failing to
 * delete it would leave a CF script with a DO namespace bound to a project
 * whose DB row we are about to delete — orphaning CF state with no DB pointer
 * left for retry. So this MUST succeed before the DB cascade.
 */
async function deleteSandboxHostScript(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Failed to delete sandbox host script ${scriptName}: ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Critical CF cleanup. These deletes MUST succeed before the DB cascade,
 * otherwise we orphan CF state with no DB pointer left for retry.
 *
 * Currently:
 *   - Sandbox host script (`do-host-${slug}`) in the dispatch namespace.
 *   - Container application(s) referenced by `resources` rows of type
 *     `container`.
 *
 * Throws on the first non-404 failure. The caller MUST NOT proceed to
 * `deleteProjectCascade` if this throws.
 */
async function cleanupCriticalResources(
  c: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug'>,
): Promise<void> {
  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;

  // Host script DELETE runs unconditionally — 404 is treated as idempotent
  // success, so the cost for non-sandbox projects is a single cheap call.
  // Gating this on `resources` would create a critical leak: if a past
  // `provisionSandboxHost` PUT the host script but then the resources UPSERT
  // failed (deploy.ts catch path also failed, e.g. network drop), no row
  // exists and the host would be orphaned with no DB pointer for retry.
  await deleteSandboxHostScript(
    c.env.CF_ACCOUNT_ID,
    c.env.CF_API_TOKEN,
    dispatchNamespace,
    getSandboxHostScriptName(project.slug),
  );

  const resources = await getProjectResources(c.get('db'), projectId);
  for (const resource of resources) {
    if (resource.type !== 'container') {
      continue;
    }
    await deleteContainerApplicationIdempotent(
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
      resource.cf_id,
    );
  }

  // Orphan-recovery fallback: a past `provisionSandboxHost` failure could
  // have left a CF container app behind without a corresponding `resources`
  // row (e.g. CF POST succeeded, DB UPSERT failed, deploy rolled back). The
  // primary loop above only catches container apps that have a row; this
  // fallback uses the deterministic name (`${projectId}-void-sandbox`) to
  // locate orphans by name and DELETE them. Only covers the default
  // containerName ('void-sandbox') because non-default names are rare and
  // would have a `resources` row whenever they're successfully written.
  //
  // Runs unconditionally for the same reason as the host DELETE above: the
  // failure mode this catches (resources row missing) means we can't gate
  // on resources presence without defeating the recovery's purpose. The
  // GET listing is cheap enough to absorb on every teardown.
  const orphanName = sandboxContainerApplicationName(projectId, 'void-sandbox');
  const alreadyDeletedCfIds = new Set(
    resources.filter((r) => r.type === 'container').map((r) => r.cf_id),
  );
  const orphan = await findContainerApplication(
    c.env.CF_ACCOUNT_ID,
    c.env.CF_API_TOKEN,
    orphanName,
  );
  if (orphan && !alreadyDeletedCfIds.has(orphan.id)) {
    await deleteContainerApplicationIdempotent(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, orphan.id);
  }
}

/**
 * Best-effort CF cleanup. Failures here become warnings but DO NOT block the
 * DB cascade. These resources are either independently re-derivable (KV
 * routing entries, deployment-scoped worker scripts) or come with their own
 * recovery story (D1 / KV / R2 retention via CF account-level cleanup).
 */
async function cleanupBestEffortResources(
  c: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug'>,
): Promise<Array<string>> {
  const warnings: Array<string> = [];
  const warn = (msg: string) => (err: unknown) => {
    warnings.push(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const [projectDeployments, resources, projectDomains] = await Promise.all([
    getAllProjectDeployments(c.get('db'), projectId),
    getProjectResources(c.get('db'), projectId),
    getDomainsByProjectId(c.get('db'), projectId),
  ]);

  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  // Note: the sandbox host script is handled in `cleanupCriticalResources`
  // and must NOT be retried here.
  const workerNames = new Set([
    getLegacyProjectWorkerName(project.slug),
    ...projectDeployments.map((deployment) =>
      getProjectDeploymentWorkerName(project.slug, deployment.id),
    ),
  ]);

  // Delete user-facing worker scripts before queue resources so CF no longer
  // sees queue bindings in attached Workers.
  await Promise.all(
    Array.from(workerNames, (workerName) =>
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` } },
      )
        .then(async (cfRes) => {
          if (!cfRes.ok && cfRes.status !== 404) {
            warnings.push(`Failed to delete worker ${workerName}: ${await cfRes.text()}`);
          }
        })
        .catch(warn(`Failed to delete worker ${workerName}`)),
    ),
  );

  const cleanup: Array<Promise<void>> = [];

  // Best-effort CF resource cleanup (D1, KV, R2, Queue, Hyperdrive — user-
  // provisioned resources). Container resources were handled as critical above.
  for (const resource of resources) {
    if (resource.type === 'container') {
      continue;
    }
    const del = deleteCloudflareResource(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource);
    cleanup.push(del.catch(warn(`Failed to delete ${resource.type} resource ${resource.cf_id}`)));
  }

  // Clear cron scheduler DO unconditionally — /clear is idempotent
  // (deleteAll + deleteAlarm). KV `hasCrons` is omitted when false and
  // missing on older entries; the PG manifest is the authoritative source,
  // and unconditional clear avoids a stale-KV gate.
  cleanup.push(clearCronScheduler(c.env, projectId));

  // KV routing entry
  cleanup.push(c.env.ROUTING.delete(project.slug).catch(warn('Failed to delete routing entry')));

  // Queue routing KV entries
  for (const q of resources.filter((r) => r.type === 'queue')) {
    cleanup.push(
      c.env.ROUTING.delete(`queue:${getProjectQueueName(projectId, q.binding_name)}`).catch(
        warn('Failed to delete queue routing entry'),
      ),
    );
  }

  // Custom hostnames from CF + KV
  for (const domain of projectDomains) {
    cleanup.push(
      deleteCustomHostname(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, domain.cf_hostname_id).catch(
        warn(`Failed to delete custom hostname ${domain.hostname}`),
      ),
    );
    cleanup.push(
      c.env.ROUTING.delete(`domain:${domain.hostname}`).catch(
        warn('Failed to delete domain routing entry'),
      ),
    );
  }

  await Promise.all(cleanup);
  return warnings;
}

/**
 * Acquire the project-row lock, flip status='deleting' (if not already), and
 * mark every non-terminal deployment as 'canceling'. Idempotent for repeated
 * teardown attempts.
 *
 * Holding the FOR UPDATE lock across the status flip + deployment cancellation
 * serializes with `provisionSandboxHost`, which also takes the same lock and
 * checks status. Any in-flight deploy that already passed its own
 * `provisionSandboxHost` lock check (and thus committed CF host + container
 * state) will observe status='canceling' on its NEXT
 * `assertDeploymentNotCanceled` call inside `routes/deploy.ts` and abort
 * before issuing further CF mutations (worker PUT, asset session, routing
 * flip, etc.).
 */
async function lockAndMarkDeleting(db: Db, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const txDb = tx as unknown as Db;
    const lockedProject = await getProject(txDb, projectId);
    if (!lockedProject) {
      throw new Error('project disappeared during deletion');
    }
    if (lockedProject.status !== 'deleting') {
      await tx
        .update(projectsTable)
        .set({ status: 'deleting' })
        .where(eq(projectsTable.id, projectId));
    }
    // Mark every non-terminal deployment as 'canceling' so the deploy
    // pipeline's `assertDeploymentNotCanceled` checks observe the cancellation
    // and abort before further CF mutations. We do this regardless of whether
    // the project status was already 'deleting' to cover replays where the
    // status flip succeeded but the deployment cancellation didn't commit
    // (e.g. earlier teardown crashed mid-tx).
    await tx
      .update(deploymentsTable)
      .set({
        status: 'canceling',
        updated_at: drizzleSql`now()`,
        error_message: drizzleSql`COALESCE(${deploymentsTable.error_message}, 'project deleted')`,
      })
      .where(
        and(
          eq(deploymentsTable.project_id, projectId),
          notInArray(deploymentsTable.status, TERMINAL_DEPLOYMENT_STATUSES),
        ),
      );
  });
}

/**
 * Tear down a project end-to-end:
 *   1. Take FOR UPDATE on the project row, flip status='deleting' (if not
 *      already), and mark all non-terminal deployments as 'canceling' so any
 *      in-flight deploy aborts before further CF mutations.
 *   2. Run critical CF cleanup (sandbox host script + container apps). Throws
 *      on non-404 failure; the caller should surface a 5xx and the DB row
 *      remains, allowing retry.
 *   3. Run best-effort CF cleanup (D1, KV, R2, queues, hyperdrive, custom
 *      hostnames, routing entries, deployment workers). Failures become
 *      warnings.
 *   4. Cascade-delete the project from the DB (domains → resources →
 *      secrets → deployments → project).
 *
 * This is the ONLY caller of `cleanupCriticalResources`,
 * `cleanupBestEffortResources`, and `deleteProjectCascade` for the project-
 * teardown flow. Route handlers must use this helper instead of calling those
 * pieces directly so the lock + status flip + deployment cancellation cannot
 * be bypassed.
 */
export async function teardownProject(
  c: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug' | 'status'>,
): Promise<{ warnings: Array<string> }> {
  // Always run lock + mark — idempotent for `status='deleting'` (the helper
  // skips the flip and just (re-)marks any non-terminal deployments). This
  // covers retried teardown after partial failure where the previous attempt
  // crashed before deployment cancellations committed.
  await lockAndMarkDeleting(c.get('db'), projectId);

  await cleanupCriticalResources(c, projectId, project);
  const warnings = await cleanupBestEffortResources(c, projectId, project);
  await deleteProjectCascade(c.get('db'), projectId);
  return { warnings };
}
