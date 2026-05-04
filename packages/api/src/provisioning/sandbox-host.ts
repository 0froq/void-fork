import { sql as drizzleSql, and, eq } from 'drizzle-orm';
import { retryWithBackoff } from '../cf-api.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import type { Db } from '../db.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { getSandboxHostScriptName } from '../naming.ts';
import { resources } from '../schema.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';
import {
  type ContainerApplicationInfo,
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  findDurableObjectNamespaceId,
  tryCreateContainerApplication,
} from './containers.ts';
import { BUNDLE_BYTES, COMPATIBILITY_DATE } from './sandbox-host-bundle.generated.ts';

type Env = ApiEnv['Bindings'];

const HOST_MIGRATION_TAG = 'void-sandbox-host-v1';
const DEFAULT_INSTANCE_TYPE = 'lite';
const DEFAULT_MAX_INSTANCES = 20;

/**
 * Result of `provisionSandboxHost`. Contains everything the deploy pipeline
 * needs to (a) emit a cross-script DO binding on the per-deploy user worker
 * and (b) reconcile container drift on subsequent deploys.
 */
export type SandboxHostInfo = {
  scriptName: string;
  namespaceId: string;
  containerApplicationId: string;
};

/**
 * Thrown by `provisionSandboxHost` when the project has been marked for
 * deletion. The deploy pipeline catches this and fails the deploy cleanly
 * before any CF mutation.
 */
export class ProjectDeletingError extends Error {
  constructor(projectId: string) {
    super(`project ${projectId} is being deleted; sandbox provisioning aborted`);
    this.name = 'ProjectDeletingError';
  }
}

/**
 * Provision the per-project sandbox DO host (`do-host-${slug}`) and its
 * companion container application. Runs at the start of every sandbox-using
 * deploy, BEFORE user-worker metadata assembly and BEFORE user-worker PUT.
 *
 * The body runs inside a `db.transaction` whose first statement is
 * `SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`. Holding the
 * project-row lock across CF API calls is the only way to genuinely
 * serialize concurrent first-deploy CF mutations (host PUT, container POST):
 * the alternative (lock only around the resources upsert) leaves a window
 * where two concurrent first deploys both PUT the host with `migrations`
 * fields and both POST the container, ending with a resource row that
 * disagrees with CF reality. See design-doc 0067 §2 "Why hold the lock
 * across CF calls".
 *
 * Behaviour matrix (§2 of design-doc 0067):
 *
 * 1. Status check: throw `ProjectDeletingError` if the project is being
 *    deleted.
 * 2. Always-PUT host script: idempotent PUT via `putSandboxHostScript`
 *    (read-tag-first; OMITS `migrations` when the live tag matches so no
 *    namespace rotation occurs). Runs unconditionally on every invocation
 *    so platform-side host-metadata fixes (e.g. the `containers` capability
 *    marker) propagate to existing tenants on their next deploy.
 * 3. Cached fast path: if a `resources` row exists with `metadata.namespaceId`,
 *    `metadata.hostScriptName`, and a non-null `cf_id`, GET the container
 *    app and verify the container's `durable_objects.namespace_id` matches.
 *    Also verify the live host's SANDBOX binding still resolves to the
 *    expected namespace (catches external host delete + recreate). On
 *    all-pass, only reconcile container config drift (image / instance_type
 *    / max_instances) via PATCH + rollout, then return the cached info.
 * 4. Create-or-recover: read the namespace_id from the host's bindings
 *    endpoint (with retry/backoff to absorb propagation lag), locate any
 *    pre-existing container app by name. If a same-name app exists, branch
 *    by namespace: same as the host's freshly-minted namespace → drift-
 *    reconcile and reuse; bound to the cached previous namespace → safe
 *    external-delete recovery (DELETE the stale app, POST a fresh one);
 *    bound to anything else → throw with a runbook hint (pre-PR-#0067
 *    stuck-tenant or unexpected mismatch — operator must manually
 *    `wrangler containers delete` before the next deploy, see
 *    `meta/operations.md` "Pre-PR-#0067 sandbox cutover"). Otherwise POST a
 *    fresh container app, and UPSERT the resources row using the natural
 *    key `(project_id, type='container', binding_name=containerName)`.
 */
export async function provisionSandboxHost(
  env: Env,
  db: Db,
  projectId: string,
  slug: string,
  containerName: string | undefined,
  desiredImage: string,
  desiredInstanceType: string | undefined,
  desiredMaxInstances: number | undefined,
): Promise<SandboxHostInfo> {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;
  const dispatchNamespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const resolvedContainerName = containerName ?? 'void-sandbox';
  const hostScriptName = getSandboxHostScriptName(slug);
  const containerAppName = sandboxContainerApplicationName(projectId, resolvedContainerName);
  const desiredInstanceTypeResolved = desiredInstanceType ?? DEFAULT_INSTANCE_TYPE;
  const desiredMaxInstancesResolved = desiredMaxInstances ?? DEFAULT_MAX_INSTANCES;

  return db.transaction(async (tx) => {
    // Per-project row lock. MUST be the first statement so all subsequent
    // reads/writes serialize against any concurrent deploy / teardown that
    // also locks this row.
    await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const txDb = tx as unknown as Db;

    // Status check (§7). Re-read inside the lock so we observe any
    // teardown that flipped status='deleting' before we acquired the lock.
    const project = await getProject(txDb, projectId);
    if (!project) {
      throw new Error(`project ${projectId} not found`);
    }
    if (project.status === 'deleting') {
      throw new ProjectDeletingError(projectId);
    }

    // Always-PUT the host script on every invocation, BEFORE the resource
    // lookup / cached fast path. Two reasons:
    //
    //   1. Forward-fix propagation. PR #131 shipped host metadata WITHOUT
    //      the `containers: [{ class_name: 'Sandbox' }]` capability marker,
    //      which is a hard prerequisite for cross-script DO bindings on a
    //      container-backed class (CF rejects the user-worker PUT with
    //      `DURABLE_OBJECT_NOT_CONTAINER_ENABLED` otherwise). Existing
    //      tenants whose host was created before this fix would otherwise
    //      keep their broken metadata indefinitely because the cached fast
    //      path skipped the host PUT entirely.
    //
    //   2. The host PUT is genuinely idempotent. `putSandboxHostScript`
    //      does a read-tag-first against CF: when the live `migration_tag`
    //      already equals HOST_MIGRATION_TAG it OMITS the `migrations`
    //      field, so no namespace rotation occurs — only the metadata
    //      (compat date / flags / bindings / containers) is refreshed.
    //
    // DO NOT remove this unconditional PUT without a host-upgrade plan —
    // it is the only mechanism by which platform-side metadata fixes ever
    // reach existing tenants.
    await putSandboxHostScript(accountId, apiToken, dispatchNamespace, slug);

    // Resource lookup. Natural key is `(project_id, type='container',
    // binding_name=containerName)` — matches `upsertContainerResource` at
    // packages/api/src/db.ts:889-900 and the existing write path at
    // deploy.ts:1201-1205. Stuck-tenant rows are keyed as `'void-sandbox'`
    // (the manifest's containerName), NOT `'SANDBOX'` (the DO binding name).
    const [existing] = await txDb
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.project_id, projectId),
          eq(resources.type, 'container'),
          eq(resources.binding_name, resolvedContainerName),
        ),
      )
      .limit(1);

    const cachedNamespaceId =
      existing && typeof existing.metadata === 'object' && existing.metadata !== null
        ? ((existing.metadata as Record<string, unknown>).namespaceId as string | undefined)
        : undefined;
    const cachedHostScriptName =
      existing && typeof existing.metadata === 'object' && existing.metadata !== null
        ? ((existing.metadata as Record<string, unknown>).hostScriptName as string | undefined)
        : undefined;

    // Cached fast path (§2 step 2).
    if (existing && existing.cf_id && cachedNamespaceId && cachedHostScriptName) {
      const cached = await verifyAndReconcileCached({
        accountId,
        apiToken,
        dispatchNamespace,
        hostScriptName: cachedHostScriptName,
        applicationId: existing.cf_id,
        expectedNamespaceId: cachedNamespaceId,
        desiredImage,
        desiredInstanceType: desiredInstanceTypeResolved,
        desiredMaxInstances: desiredMaxInstancesResolved,
      });
      if (cached) {
        return {
          scriptName: cachedHostScriptName,
          namespaceId: cachedNamespaceId,
          containerApplicationId: existing.cf_id,
        };
      }
      // Fall through to create-or-recover.
    }

    // Create-or-recover (§2 step 4). The host PUT already happened
    // unconditionally above, so we proceed directly to the namespace
    // probe / container reconcile.

    // CF's per-script bindings endpoint has brief propagation lag after a
    // successful PUT — `findDurableObjectNamespaceId` can transiently 404 or
    // return a binding list missing the SANDBOX entry for hundreds of ms.
    // Wrap the lookup in retry/backoff so a healthy deploy doesn't fail on
    // visibility delay. (The helper's JSDoc explicitly leaves absorbing this
    // lag to the caller.)
    const namespaceId = await retryWithBackoff(
      async () => {
        try {
          return await findDurableObjectNamespaceId(
            accountId,
            apiToken,
            dispatchNamespace,
            hostScriptName,
            'SANDBOX',
            'Sandbox',
          );
        } catch (err) {
          // Treat any error here (CF 404, missing binding) as transient
          // propagation lag and retry. If the host genuinely doesn't have
          // the binding after `maxRetries`, the surrounding error message
          // surfaces the lookup miss.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[sandbox-host] namespace probe miss for ${hostScriptName} (will retry): ${msg}`,
          );
          return undefined;
        }
      },
      {
        maxRetries: 8,
        delayMs: 500,
        errorMessage: `sandbox host DO namespace was not visible after PUT (host=${hostScriptName})`,
      },
    );

    // Locate any pre-existing container app by name and decide between three
    // disjoint outcomes:
    //
    //   (a) Same-namespace reuse — the container is already bound to the
    //       host's freshly-minted namespace (typical: partial-failure replay
    //       where host PUT + container POST both landed but the resources
    //       UPSERT did not). Drift-reconcile and continue.
    //
    //   (b) External-delete recovery — we have a verified `cachedNamespaceId`
    //       from the resources row AND the existing container is bound to
    //       that namespace. The host script was deleted out-of-band (e.g.
    //       operator ran `wrangler delete`), `putSandboxHostScript` minted a
    //       fresh host namespace, and the container is the one we previously
    //       provisioned. The DO namespace is immutable on PATCH, so safe
    //       recovery is DELETE+POST against the new namespace.
    //
    //   (c) Pre-PR-#0067 stuck-tenant or unexpected mismatch — no verified
    //       cached pointer to the existing container's namespace, so we
    //       can't safely auto-DELETE. Throw with a runbook hint and let the
    //       operator perform the cutover (`wrangler containers delete`).
    //
    // Any pre-existing app is therefore ONLY safely recoverable when we have
    // independent verification via the cached metadata that the platform
    // owned that container previously. Otherwise the operator must
    // manually delete it before the next deploy. See `meta/operations.md`
    // "Pre-PR-#0067 sandbox cutover".
    const preExisting = await findContainerApplication(accountId, apiToken, containerAppName);
    let application: ContainerApplicationInfo | undefined;
    // Track whether THIS invocation created the container app. Only newly
    // created apps may be deleted by the UPSERT compensation path below —
    // pre-existing same-namespace apps and post-409 re-found apps belong to
    // a successful prior deploy, and a transient pg failure on the resources
    // UPSERT must not destroy a working tenant's container.
    let createdInThisAttempt = false;

    if (preExisting) {
      const preNamespaceId = preExisting.durable_objects?.namespace_id;
      if (preNamespaceId === namespaceId) {
        // (a) Same-namespace reuse.
        await reconcileContainerDrift(accountId, apiToken, preExisting, {
          image: desiredImage,
          instanceType: desiredInstanceTypeResolved,
          maxInstances: desiredMaxInstancesResolved,
        });
        application = preExisting;
      } else if (cachedNamespaceId && preNamespaceId === cachedNamespaceId) {
        // (b) External-delete recovery. The host script was deleted
        // externally, putSandboxHostScript minted a fresh host namespace,
        // and the container is still bound to the (now-stale) namespace
        // we previously cached. DELETE+POST is safe because the cached
        // pointer verifies platform ownership of the stale container.
        console.warn(
          `[sandbox-host] external-delete recovery for project ${projectId}: ` +
            `host namespace rotated from ${cachedNamespaceId} to ${namespaceId}; ` +
            `DELETE+POST stale container ${preExisting.id}.`,
        );
        await deleteContainerApplicationIdempotent(accountId, apiToken, preExisting.id);
        const recovered = await tryCreateContainerApplication(accountId, apiToken, {
          name: containerAppName,
          image: desiredImage,
          namespaceId,
          instanceType: desiredInstanceTypeResolved,
          maxInstances: desiredMaxInstancesResolved,
        });
        if (!recovered) {
          throw new Error(
            `container application "${containerAppName}" POST returned 409 immediately after ` +
              `DELETE during external-delete recovery for project ${projectId}; manual ` +
              `intervention required.`,
          );
        }
        application = recovered;
        createdInThisAttempt = true;
      } else {
        // (c) Pre-PR-#0067 stuck-tenant or unexpected mismatch.
        throw new Error(
          `container application "${containerAppName}" exists but is bound to namespace ` +
            `${preNamespaceId ?? 'none'} (expected ${namespaceId}). This is the pre-PR-#0067 ` +
            `stuck-tenant state OR an unexpected mismatch. Operator action required: ` +
            `wrangler containers delete ${containerAppName}, then redeploy. ` +
            `See meta/operations.md "Pre-PR-#0067 sandbox cutover".`,
        );
      }
    } else {
      // No pre-existing container — fresh POST.
      const created = await tryCreateContainerApplication(accountId, apiToken, {
        name: containerAppName,
        image: desiredImage,
        namespaceId,
        instanceType: desiredInstanceTypeResolved,
        maxInstances: desiredMaxInstancesResolved,
      });
      if (created) {
        application = created;
        createdInThisAttempt = true;
      } else {
        // 409 under the lock indicates an out-of-band creation (operator
        // action, prior failed teardown) — log WARN, re-find, require
        // namespace match.
        console.warn(
          `[provisionSandboxHost] unexpected 409 on container POST under lock for ` +
            `project=${projectId} app=${containerAppName} — investigating; re-finding`,
        );
        const refound = await findContainerApplication(accountId, apiToken, containerAppName);
        if (!refound) {
          throw new Error(
            `container application "${containerAppName}" reported as already-existing ` +
              `but could not be located on re-find`,
          );
        }
        if (refound.durable_objects?.namespace_id !== namespaceId) {
          throw new Error(
            `container application "${containerAppName}" exists but is bound to a ` +
              `different durable object namespace (expected ${namespaceId}, found ` +
              `${refound.durable_objects?.namespace_id ?? 'none'}). The DO namespace ` +
              `binding is immutable on PATCH; manual cleanup required.`,
          );
        }
        // Namespace matches — reconcile config drift before returning. NOT
        // marked as `createdInThisAttempt` because the app pre-dated this
        // invocation; the UPSERT compensation path must not delete it.
        await reconcileContainerDrift(accountId, apiToken, refound, {
          image: desiredImage,
          instanceType: desiredInstanceTypeResolved,
          maxInstances: desiredMaxInstancesResolved,
        });
        application = refound;
      }
    }

    // UPSERT the resources row using the same natural key the existing
    // code writes. The unique constraint is `(project_id, type, binding_name)`.
    //
    // Compensating cleanup: if the UPSERT throws (PG conflict, lost
    // connection, etc.), the surrounding pg transaction will roll back
    // automatically — and if THIS invocation created the container app, that
    // app would otherwise be orphaned (no `resources` row points at it). Self-
    // heal on the next deploy works because `findContainerApplication` looks
    // up by deterministic name, but if the project gets deleted before the
    // next deploy the orphan stays in CF forever. Idempotently DELETE the
    // newly-created container here so the failed deploy leaves no leak.
    //
    // Critically: ONLY delete when `createdInThisAttempt` is true. A pre-
    // existing same-namespace app or a post-409 re-found app belongs to a
    // successful prior deploy; deleting it on a transient pg failure would
    // destroy a valid working tenant's sandbox. Those rows already have a
    // resources row from their original deploy, so there is no leak to
    // compensate for in the first place.
    try {
      await txDb
        .insert(resources)
        .values({
          id: generateId('res'),
          project_id: projectId,
          type: 'container',
          cf_id: application.id,
          binding_name: resolvedContainerName,
          metadata: { namespaceId, hostScriptName },
        })
        .onConflictDoUpdate({
          target: [resources.project_id, resources.type, resources.binding_name],
          set: {
            cf_id: application.id,
            metadata: { namespaceId, hostScriptName },
          },
        });
    } catch (err) {
      if (createdInThisAttempt) {
        try {
          await deleteContainerApplicationIdempotent(accountId, apiToken, application.id);
        } catch (cleanupErr) {
          console.warn(
            `[sandbox-host] failed to clean up newly-created container ${application.id} ` +
              `after UPSERT failure for project ${projectId}`,
            cleanupErr,
          );
        }
      }
      throw err;
    }

    return {
      scriptName: hostScriptName,
      namespaceId,
      containerApplicationId: application.id,
    };
  });
}

/**
 * Read the live `migration_tag` for a host script in the dispatch namespace.
 * Returns `null` on 404 or when the script has no tag yet.
 *
 * Mirrors wrangler's read-before-PUT discipline (see node_modules/.pnpm/
 * wrangler/wrangler-dist/cli.js:301012-301083): the script's CURRENT
 * `migration_tag` is the source of truth, and the next PUT either omits
 * `migrations` (preserving the tag) or sends `{ old_tag, new_tag, steps }`.
 * Replaying a `new_sqlite_classes` step against a script that already has
 * the class is what would rotate the namespace and break the whole design.
 */
export async function fetchScriptMigrationTag(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
): Promise<string | null> {
  const url = `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}`;
  try {
    const result = await cfFetch<{ migration_tag?: string | null }>(url, apiToken);
    return result?.migration_tag ?? null;
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * PUT the per-project sandbox DO host script.
 *
 * Read-tag-first: queries the script's current `migration_tag`. If the live
 * tag matches `'void-sandbox-host-v1'`, OMITS the `migrations` field so CF
 * preserves the existing tag and the namespace. If the script doesn't exist
 * yet (`tag === null`), includes initial migrations
 * `{ tag: 'void-sandbox-host-v1', new_sqlite_classes: ['Sandbox'] }`. Any
 * other tag indicates a future host upgrade and is out of scope.
 *
 * Always declares the same-script `durable_object_namespace` self-binding so
 * the namespace_id is exposed via the per-script bindings endpoint
 * (`findDurableObjectNamespaceId` reads exactly this binding shape — the
 * host's own runtime never invokes it; the binding exists only so the
 * namespace_id is reflected).
 *
 * Always declares `containers: [{ class_name: 'Sandbox' }]` regardless of
 * the migration_tag branch. CF requires the script that OWNS a DO class to
 * declare it as container-enabled before any cross-script DO binding to
 * that class will be accepted; without this field user-worker PUTs fail
 * with `DURABLE_OBJECT_NOT_CONTAINER_ENABLED`.
 */
export async function putSandboxHostScript(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  slug: string,
): Promise<void> {
  const scriptName = getSandboxHostScriptName(slug);
  const tag = await fetchScriptMigrationTag(accountId, apiToken, dispatchNamespace, scriptName);

  const metadata: Record<string, unknown> = {
    main_module: 'index.js',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    bindings: [{ type: 'durable_object_namespace', name: 'SANDBOX', class_name: 'Sandbox' }],
    // Tells CF this DO class is backed by a container application. Without
    // this, cross-script DO bindings from user workers to the Sandbox class
    // on this host fail at PUT time with DURABLE_OBJECT_NOT_CONTAINER_ENABLED.
    // The container app itself is created via the separate
    // /containers/applications API by provisionSandboxHost; this field is a
    // class-capability declaration only. Always present in BOTH the
    // first-create branch (tag === null) and the re-PUT branch
    // (tag === HOST_MIGRATION_TAG).
    containers: [{ class_name: 'Sandbox' }],
  };

  if (tag === null) {
    // First create — declare the class via initial migrations.
    // Shape matches the CF Workers Upload API multipart form (`{ new_tag, steps }`)
    // NOT the wrangler config-array shape (`[{ tag, new_sqlite_classes }]`).
    metadata.migrations = {
      new_tag: HOST_MIGRATION_TAG,
      steps: [{ new_sqlite_classes: ['Sandbox'] }],
    };
  } else if (tag === HOST_MIGRATION_TAG) {
    // Already migrated — omit `migrations` to preserve the namespace.
  } else {
    // Future host upgrades are out of scope per design-doc 0067 §2a.
    throw new Error(
      `unexpected migration_tag '${tag}' on host script for slug=${slug}; ` +
        `host upgrade flow is not implemented`,
    );
  }

  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append(
    'index.js',
    new Blob([BUNDLE_BYTES], { type: 'application/javascript+module' }),
    'index.js',
  );

  const url = `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}` },
    body: formData,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `sandbox host script PUT failed (${response.status}) for ${scriptName}: ${body.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface ContainerConfigDesired {
  desiredImage: string;
  desiredInstanceType: string;
  desiredMaxInstances: number;
}

interface VerifyAndReconcileArgs extends ContainerConfigDesired {
  accountId: string;
  apiToken: string;
  dispatchNamespace: string;
  hostScriptName: string;
  applicationId: string;
  expectedNamespaceId: string;
}

/**
 * Cached-fast-path verification + container-drift reconciliation. Returns
 * `true` when the cached state is intact (container present and bound to
 * the expected namespace) and any drift was reconciled via PATCH+rollout.
 * Returns `false` when any verification check fails so the caller falls
 * through to create-or-recover.
 *
 * NOTE: the host script HEAD check is intentionally absent — `provisionSandboxHost`
 * always PUTs the host script unconditionally (and idempotently) before
 * reaching the cached fast path, so a separate HEAD would just be a wasted
 * round-trip. The live binding probe in step 3b still validates that the
 * SANDBOX class on the host resolves to the expected namespace_id.
 */
async function verifyAndReconcileCached(args: VerifyAndReconcileArgs): Promise<boolean> {
  // 2. GET the container app by id. 404 => container is gone, fall through.
  let app: ContainerApplicationInfo;
  try {
    app = await cfFetch<ContainerApplicationInfo>(
      `${CF_API_BASE}/${args.accountId}/containers/applications/${args.applicationId}`,
      args.apiToken,
    );
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) {
      return false;
    }
    throw err;
  }

  // 3. Namespace match. Mismatch => fall through (recovery DELETEs the
  // mismatched app and POSTs fresh).
  if (app.durable_objects?.namespace_id !== args.expectedNamespaceId) {
    return false;
  }

  // 3b. Verify the live host script's SANDBOX binding still resolves to the
  // expected namespace. If the host was externally deleted+recreated, its
  // namespace would have rotated while our cache still holds the old id.
  // On mismatch (or any error — e.g. binding absent), fall through to
  // create-or-recover which will safely auto-recover when the cached
  // namespace matches the existing container (DELETE+POST against the new
  // host namespace), or throw with a runbook hint for unexpected mismatches.
  try {
    const liveNamespaceId = await findDurableObjectNamespaceId(
      args.accountId,
      args.apiToken,
      args.dispatchNamespace,
      args.hostScriptName,
      'SANDBOX',
      'Sandbox',
    );
    if (liveNamespaceId !== args.expectedNamespaceId) {
      return false;
    }
  } catch {
    // Treat any error (missing binding, unexpected response) as a
    // verification miss and fall through to create-or-recover.
    return false;
  }

  // 4. Reconcile container config drift.
  await reconcileContainerDrift(args.accountId, args.apiToken, app, {
    image: args.desiredImage,
    instanceType: args.desiredInstanceType,
    maxInstances: args.desiredMaxInstances,
  });
  return true;
}

/**
 * Reconcile container config drift (image / instance_type / max_instances)
 * via PATCH + rollout. No-ops when `app` already matches `desired`. Extracted
 * so both the cached-fast-path and the create-or-recover path apply the same
 * reconciliation logic when returning a pre-existing same-namespace container.
 *
 * Only PATCH triggers a rollout; POST (first creation) boots the application
 * directly, so this helper is only appropriate for containers that already
 * exist and are bound to the correct namespace.
 */
async function reconcileContainerDrift(
  accountId: string,
  apiToken: string,
  app: ContainerApplicationInfo,
  desired: { image: string; instanceType: string; maxInstances: number },
): Promise<void> {
  if (
    app.configuration?.image === desired.image &&
    app.configuration?.instance_type === desired.instanceType &&
    app.max_instances === desired.maxInstances
  ) {
    return; // no drift
  }

  const patchBody = {
    configuration: {
      image: desired.image,
      instance_type: desired.instanceType,
    },
    max_instances: desired.maxInstances,
    scheduling_policy: 'default',
    rollout_active_grace_period: 0,
  };
  await cfFetch(`${CF_API_BASE}/${accountId}/containers/applications/${app.id}`, apiToken, {
    method: 'PATCH',
    body: JSON.stringify(patchBody),
  });
  await cfFetch(
    `${CF_API_BASE}/${accountId}/containers/applications/${app.id}/rollouts`,
    apiToken,
    {
      method: 'POST',
      body: JSON.stringify({
        description: 'void platform sandbox config update',
        strategy: 'rolling',
        target_configuration: patchBody.configuration,
        step_percentage: 100,
        kind: 'full_auto',
      }),
    },
  );
}

/**
 * Compute the CF container application name for a project's sandbox.
 * Lowercased and underscores converted to dashes because CF container
 * names reject uppercase / `_`. This is the SAME naming rule the
 * pre-Task-4 `getSandboxContainerApplicationName` helper in deploy.ts
 * applied — the rule is preserved verbatim so stuck-tenant container
 * apps can be located by name during the create-or-recover branch.
 *
 * Exported so cleanup.ts can compute the deterministic name when running
 * orphan-recovery for tenants whose `resources` row is missing (e.g. a
 * past deploy crashed between the CF container POST and the DB UPSERT).
 */
export function sandboxContainerApplicationName(projectId: string, containerName: string): string {
  return `${projectId}-${containerName}`.toLowerCase().replaceAll('_', '-');
}
