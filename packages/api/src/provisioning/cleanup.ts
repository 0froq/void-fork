import { sql as drizzleSql, and, eq, notInArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteWorkerBundle } from '../assets.ts';
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
} from '../naming.ts';
import { deployments as deploymentsTable, projects as projectsTable } from '../schema.ts';
import type { DeployManifest, Project, Resource } from '../types.ts';
import {
  deleteCustomHostname,
  deleteD1Database,
  deleteHyperdrive,
  deleteKVNamespace,
  deleteQueue,
  deleteR2Bucket,
} from './cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  perDeployContainerApplicationName,
} from './containers.ts';

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
 * Critical CF cleanup. These deletes MUST succeed before the DB cascade,
 * otherwise we orphan CF state with no DB pointer left for retry.
 *
 * Currently:
 *   - Container application(s) referenced by `resources` rows of type
 *     `container`.
 *   - Per-deploy container application orphans located by deterministic name
 *     (recovery for deploys whose container POST succeeded but whose resources
 *     UPSERT did not commit before the deploy rolled back).
 *
 * Throws on the first non-404 failure. The caller MUST NOT proceed to
 * `deleteProjectCascade` if this throws.
 */
async function cleanupCriticalResources(
  c: Context<ApiEnv>,
  projectId: string,
  _project: Pick<Project, 'slug'>,
): Promise<void> {
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

  // Orphan-recovery fallback: a past `provisionPerDeployContainer` failure
  // could have left a CF container app behind without a corresponding
  // `resources` row (e.g. CF POST succeeded, DB UPSERT failed, deploy rolled
  // back). The primary loop above only catches container apps that have a
  // row; this fallback enumerates every deployment for the project, parses
  // its manifest, and locates per-deploy container orphans by deterministic
  // name (`perDeployContainerApplicationName`).
  //
  // Runs unconditionally because the failure mode this catches (resources
  // row missing) means we can't gate on resources presence without
  // defeating the recovery's purpose. Per-deployment GETs are cheap enough
  // to absorb on every teardown — and teardown is rare relative to deploy.
  //
  // Race-mitigation (full fix is project-level locking — see design-doc 0067):
  // an in-flight deploy whose container POST lands AFTER our first scan
  // would leak as an orphan once the DB cascade nulls its deployment row.
  // Run the scan TWICE with a short delay; the second pass catches any POST
  // that completed during the gap. `assertProjectNotDeleting` /
  // `assertDeploymentNotCanceled` checks in the deploy pipeline mean an
  // in-flight deploy aborts shortly after `lockAndMarkDeleting` flips the
  // status, so a 2s delay is comfortably longer than the worst-case
  // post-status-flip container POST tail.
  const alreadyDeletedCfIds = new Set(
    resources.filter((r) => r.type === 'container').map((r) => r.cf_id),
  );
  await sweepPerDeployContainerOrphans(c, projectId, alreadyDeletedCfIds);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await sweepPerDeployContainerOrphans(c, projectId, alreadyDeletedCfIds);
}

/**
 * Locate per-deploy container orphans by deterministic name and delete any
 * not already in `alreadyDeletedCfIds`. Mutates the set with each new id so
 * subsequent passes skip already-handled orphans.
 */
async function sweepPerDeployContainerOrphans(
  c: Context<ApiEnv>,
  projectId: string,
  alreadyDeletedCfIds: Set<string>,
): Promise<void> {
  const allDeployments = await getAllProjectDeployments(c.get('db'), projectId);
  for (const deployment of allDeployments) {
    const manifest = parseDeploymentManifest(deployment.manifest);
    if (!manifest?.sandbox) {
      continue;
    }
    const orphanName = perDeployContainerApplicationName(
      projectId,
      deployment.id,
      manifest.sandbox.containerName ?? 'void-sandbox',
    );
    const orphan = await findContainerApplication(
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
      orphanName,
    );
    if (orphan && !alreadyDeletedCfIds.has(orphan.id)) {
      await deleteContainerApplicationIdempotent(
        c.env.CF_ACCOUNT_ID,
        c.env.CF_API_TOKEN,
        orphan.id,
      );
      alreadyDeletedCfIds.add(orphan.id);
    }
  }
}

/**
 * Best-effort manifest parse for orphan-recovery enumeration. Manifests are
 * stored as JSON-encoded text on `deployments.manifest`. Returns `null` for
 * absent or unparseable bodies so the caller can skip those rows.
 */
function parseDeploymentManifest(raw: string | null): DeployManifest | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
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

  // Delete R2 worker bundle objects under `worker-bundles/{projectId}/{deploymentId}/...`
  // for every deployment. Without this, project teardown leaves these objects
  // permanently orphaned in STATIC_ASSETS_R2 (the cascade only drops DB rows).
  // `deleteWorkerBundle` is idempotent — listing returns no objects for deploys
  // that never stored a bundle, so we don't need to gate on `bundle_stored`.
  await Promise.all(
    projectDeployments.map((deployment) =>
      deleteWorkerBundle(c.env.STATIC_ASSETS_R2, projectId, deployment.id).catch(
        warn(`Failed to delete worker bundle for deployment ${deployment.id}`),
      ),
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
 * serializes with the deploy pipeline's atomic precheck-and-claim transaction,
 * which also locks the project row and checks status. Any in-flight deploy
 * that already passed its own status check will observe status='canceling' on
 * its NEXT `assertDeploymentNotCanceled` / `assertProjectNotDeleting` call
 * inside `routes/deploy.ts` and abort before issuing further CF mutations
 * (worker PUT, asset session, routing flip, etc.).
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
 *   2. Run critical CF cleanup (container apps + per-deploy container
 *      orphan recovery). Throws on non-404 failure; the caller should surface
 *      a 5xx and the DB row remains, allowing retry.
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
