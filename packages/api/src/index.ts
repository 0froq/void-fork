import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin/middleware/auth.ts';
import adminDeployments from './admin/routes/deployments.tsx';
import adminInvitations from './admin/routes/invitations.tsx';
import adminLogin from './admin/routes/login.ts';
import adminPlatform from './admin/routes/platform.tsx';
import adminProjects from './admin/routes/projects.tsx';
import adminSignupControl from './admin/routes/signup-control.tsx';
import { dashboardHandler, adminSystem } from './admin/routes/system.tsx';
import adminUsers from './admin/routes/users.tsx';
import { hmacSignState } from './auth/hmac.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from './constants.ts';
import { type CronFireMessage, processCronFiresBatch } from './cron-fires-queue.ts';
import { CronScheduler } from './cron-scheduler.ts';
import {
  createDb,
  getUsersWithProjectsBatch,
  unsuspendUserIfReason,
  getDomainsByProjectId,
  getDomainsByProjectIds,
  getRecentlyLiveActiveDeployments,
  getPendingDomainsOlderThan,
  getPendingDomains,
  getPendingDomainsNewerThan,
  deleteDomainIfPending,
  purgeExpiredOAuthNonces,
  purgeExpiredAuthCodes,
  failStaleDeployments,
  getProject,
  getProjectsByIds,
  getUsersByIds,
  lockProjectAndGetActiveDeploymentId,
  publishRoutingIfStillActive,
  type Db,
} from './db.ts';
import { escapeHtml } from './email.ts';
import type { ApiEnv } from './env.ts';
import { ErrorAlertMonitor } from './error-alert-monitor.ts';
import { authMiddleware } from './middleware/auth.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from './naming.ts';
import { tryActivateDomain } from './provisioning/activate-domain.ts';
import {
  CloudflareApiError,
  deleteCustomHostname,
  getCustomHostname,
  getDispatchWorkerProxyToken,
} from './provisioning/cloudflare-api.ts';
import auth from './routes/auth.ts';
import deleteRoute from './routes/delete.ts';
import deploy from './routes/deploy.ts';
import domains from './routes/domains.ts';
import internalResolveResource from './routes/internal-resolve-resource.ts';
import internalResolveWorker from './routes/internal-resolve-worker.ts';
import internalRevalidate from './routes/internal-revalidate.ts';
import internalVerifyOwner from './routes/internal-verify-owner.ts';
import me from './routes/me.ts';
import projects from './routes/projects.ts';
import revalidate from './routes/revalidate.ts';
import secrets from './routes/secrets.ts';
import { projectUsage, accountUsage } from './routes/usage.ts';
import {
  applyCurrentSuspension,
  buildRoutingJson,
  buildStaticRoutingJson,
  setProjectsRoutingSuspension,
  sweepStaleQueueRoutes,
  writeProjectAccountEntry,
} from './routing.ts';
import { SandboxConcurrencyCounter } from './sandbox-concurrency-counter.ts';
import { isAdminSuspended, REASON_REQUESTS_EXCEEDED } from './suspension.ts';
import { getCurrentBillingPeriodStart, getPlanLimits } from './tiers.ts';
import type { DeployManifest, Domain, Project } from './types.ts';
import { UsageCounter } from './usage-counter.ts';
import { processUsageEventBatch } from './usage-queue.ts';

const app = new Hono<ApiEnv>()

  // Catch-all error handler. Without this, Hono returns a plain-text
  // `Internal Server Error` body which is opaque to the CLI and dashboard.
  // Routes still handle known cases inline (returning 400/404/etc. with
  // domain-specific messages); this is the safety net for unexpected
  // throws. The body is intentionally a generic string — leaking raw
  // `err.message` here would surface DB constraint names, library
  // internals, connection-string fragments, etc. to API clients. The
  // full error is logged for prod diagnosis.
  .onError((err, context) => {
    console.error('[api] unhandled error:', err);
    return context.json({ error: 'Internal Server Error' }, 500);
  })

  // Drizzle middleware — creates a Db instance per request
  .use('*', async (context, next) => {
    context.set('db', createDb(context.env.HYPERDRIVE.connectionString));
    await next();
  })

  .get('/health', (context) => context.json({ status: 'ok' }))
  .get('/capabilities', (context) =>
    context.json({
      acceptsExecutionPlans: true,
      migrationProtocolVersion: 2,
      supportedClassifierVersions: [1],
    }),
  )
  .get('/signup-restricted', (context) =>
    context.html(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Private Beta - Void</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa}.card{text-align:center;max-width:400px;padding:40px}h1{font-size:1.25rem;margin-bottom:12px}p{color:#666}</style>
</head><body>
<div class="card"><h1>Private Beta</h1><p>Sorry, we are still in private beta and your login is not currently in the allowed list. Check back later!</p></div>
</body></html>`),
  )
  .get('/invite', (context) => {
    const guideUrl = escapeHtml('https://void.cloud/guide/');
    return context.html(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>You're Invited - Void</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa}.card{text-align:center;max-width:440px;padding:40px}h1{font-size:1.5rem;margin-bottom:12px}p{color:#666;line-height:1.6;margin-bottom:20px}.btn{display:inline-block;background:#000;color:#fff;padding:12px 32px;text-decoration:none;border-radius:4px;font-weight:500;font-size:1rem}</style>
</head><body>
<div class="card">
<h1>You're Invited to Void</h1>
<p>Void is the deployment platform for the Vite ecosystem. Build and deploy full-stack apps with file-based routing, database bindings, AI integration, and edge-first infrastructure.</p>
<a href="${guideUrl}" class="btn">Get Started</a>
</div>
</body></html>`);
  })
  .route('/auth', auth)
  .route('/internal/revalidate', internalRevalidate)
  .route('/internal/resolve-resource', internalResolveResource)
  .route('/internal/resolve-worker', internalResolveWorker)
  .route('/internal/verify-owner', internalVerifyOwner)
  .use('/me', authMiddleware)
  .route('/me', me)
  .use('/projects/*', authMiddleware)
  .route('/projects', projects)
  .route('/projects', deploy)
  .route('/projects', deleteRoute)
  .route('/projects', revalidate)
  .route('/projects', secrets)
  .route('/projects', domains)
  .route('/projects', projectUsage)
  .use('/usage', authMiddleware)
  .route('/usage', accountUsage);

// Admin dashboard (HTML, cookie-based auth)
app.route('/admin', adminLogin);
app.use('/admin/*', adminAuthMiddleware);
app.get('/admin/', adminAuthMiddleware, dashboardHandler);
app.route('/admin/users', adminUsers);
app.route('/admin/projects', adminProjects);
app.route('/admin/deployments', adminDeployments);
app.route('/admin/signup-control', adminSignupControl);
app.route('/admin/invitations', adminInvitations);
app.route('/admin/platform', adminPlatform);
app.route('/admin', adminSystem);

const BATCH_SIZE = 50;

const PENDING_DOMAIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Pending custom domains created within this window are reconciled on the
// every-2-min fast tier; older ones fall back to the hourly tier. Tunable.
const RECENT_PENDING_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Cron expression for the fast reconciliation tier (every 2 minutes). Exported
// so the scheduled() branch condition and tests share the same literal.
export const FAST_CRON = '*/2 * * * *';

const MAX_PENDING_RECONCILE_PER_RUN = 200; // bound CF polling + protect later maintenance; tunable

// Recency window for the hourly live-routing reconciler: legacy NULL-marker
// active deployments are re-checked only if they went live within the last
// 24h. Bounds the one-time NULL backfill — a deploy whose routing-KV publish
// was lost (transient KV error after the go-live tx committed, all in-request
// retries exhausted) leaves a missing/stale slug route, and on a FIRST deploy
// the project is unreachable (dispatch routes purely from ROUTING KV). The
// window is wide enough that an hourly tick always re-checks a freshly-live
// deploy several times before it ages out, but narrow enough that the
// steady-state scan stays small. Explicitly-unpublished rows
// (`routing_published=false`, written only by the rollback go-live tx) are
// EXEMPT from the window — a rollback target is usually older than 24h and
// would otherwise stay invisible to the reconciler forever (see
// `getRecentlyLiveActiveDeployments`).
const RECONCILE_LIVE_ROUTING_WINDOW_MS = 24 * 60 * 60 * 1000;

// Bound the per-run reconcile scan + KV reads/writes; tunable. Reuses the same
// cap style as MAX_PENDING_RECONCILE_PER_RUN.
const MAX_LIVE_ROUTING_RECONCILE_PER_RUN = 200;

async function scheduled(
  controller: ScheduledController,
  env: ApiEnv['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.HYPERDRIVE.connectionString);

  // Fast tier (every 2 min): only reconcile recently-created pending domains
  // (within the last 30 min) so a freshly-configured custom domain comes online
  // quickly without the user polling. The heavier hourly maintenance does NOT
  // run on this tick.
  if (controller.cron === FAST_CRON) {
    const cutoff = new Date(controller.scheduledTime - RECENT_PENDING_WINDOW_MS).toISOString();
    const young = await getPendingDomainsNewerThan(db, cutoff, MAX_PENDING_RECONCILE_PER_RUN);
    if (young.length === MAX_PENDING_RECONCILE_PER_RUN) {
      console.warn(
        `[scheduled] fast pending-domain reconcile hit the per-run cap (${MAX_PENDING_RECONCILE_PER_RUN}); remaining pending domains will be processed on the next run`,
      );
    }
    // Fast tier does NOT re-trigger HTTP DCV via PATCH — only the hourly tier
    // does (see the hourly call below and tryActivateDomain's comment).
    await reconcilePendingDomains(env, db, young, false).catch((err) =>
      console.error('[scheduled] fast pending-domain reconcile failed:', err),
    );
    return;
  }

  // Hourly tier (every :00): full maintenance.

  // Auto-fail deployments stuck in active states for more than 30 minutes
  await failStaleDeployments(db)
    .then((n) => {
      if (n > 0) {
        console.log(`[scheduled] auto-failed ${n} stale deployment(s)`);
      }
    })
    .catch((err) => console.error('[scheduled] failed to clean up stale deployments:', err));

  // Republish slug/account/domain routing for recently-live deployments whose
  // ROUTING KV is missing or stale. Best-effort and isolated like the reapers
  // around it — one failure must not block the rest of the hourly maintenance.
  await reconcileLiveRouting(env, db, controller.scheduledTime).catch((err) =>
    console.error('[scheduled] live-routing reconcile failed:', err),
  );

  // Purge expired OAuth nonces and auth codes left by abandoned login flows (best-effort)
  await purgeExpiredOAuthNonces(db).catch((err) =>
    console.error('[scheduled] failed to purge expired OAuth nonces:', err),
  );
  await purgeExpiredAuthCodes(db).catch((err) =>
    console.error('[scheduled] failed to purge expired auth codes:', err),
  );

  // Reconcile ALL pending domains BEFORE the stale-cleanup janitor, so a domain
  // that only just finished validating (even one near the 7-day cutoff) gets
  // activated instead of garbage-collected.
  const allPending = await getPendingDomains(db, MAX_PENDING_RECONCILE_PER_RUN);
  if (allPending.length === MAX_PENDING_RECONCILE_PER_RUN) {
    console.warn(
      `[scheduled] hourly pending-domain reconcile hit the per-run cap (${MAX_PENDING_RECONCILE_PER_RUN}); remaining pending domains will be processed on the next run`,
    );
  }
  // Only the hourly tier re-triggers HTTP DCV via PATCH: it bounds the
  // per-account CF custom-hostname API load (the every-2-min fast tier would
  // amplify PATCH volume under a burst of young pending domains and could 429
  // other tenants' hostname operations), while still re-triggering the long
  // tail and resetting CF's decaying 7-day validation backoff once per hour.
  await reconcilePendingDomains(env, db, allPending, true).catch((err) =>
    console.error('[scheduled] hourly pending-domain reconcile failed:', err),
  );

  // Cleanup janitor: custom hostnames that have sat in `pending` for more than
  // 7 days never completed ownership/cert validation. Their CF cert order is
  // still open (CT-log noise) and — under a wildcard-CNAME hijack attempt —
  // CF's own "Moved → Deleted after 7 days" sweep may not fire. Delete the CF
  // hostname (revokes the cert order) and drop the DB row. Run once globally;
  // conservative — only `status === 'pending'` rows are eligible.
  await cleanupStalePendingDomains(env, db, controller.scheduledTime).catch((err) =>
    console.error('[scheduled] failed to clean up stale pending domains:', err),
  );

  let offset = 0;
  while (true) {
    let batch;
    try {
      batch = await getUsersWithProjectsBatch(db, BATCH_SIZE, offset);
    } catch (err) {
      console.error('[scheduled] failed to fetch user batch at offset', offset, err);
      break;
    }
    if (batch.length === 0) {
      break;
    }

    await Promise.allSettled(
      batch.map(({ user, projects }) => processUserRollover(env, db, user, projects)),
    );

    offset += BATCH_SIZE;
  }
}

// Reconcile a set of pending custom domains: for each, re-run the shared
// activation gate (tryActivateDomain) and activate it if CF has finished
// validating ownership + cert AND the project has live slug routing. This is
// what lets a domain come online after the user configures DNS without them
// re-running `void domain status`. Per-domain failures (e.g. a CF API error)
// are isolated so one bad domain never aborts the batch. `retriggerDcv` is
// forwarded to tryActivateDomain to gate the HTTP-DCV re-trigger PATCH — only
// the hourly tier passes `true` (see the scheduled() call sites).
async function reconcilePendingDomains(
  env: ApiEnv['Bindings'],
  db: Db,
  pending: ReadonlyArray<Domain>,
  retriggerDcv: boolean,
): Promise<void> {
  if (pending.length === 0) {
    return;
  }

  // Batch-load projects for the deduped set of project_ids in a single query.
  const projectIds = [...new Set(pending.map((d) => d.project_id))];
  const projectRows = await getProjectsByIds(db, projectIds);
  const projectMap = new Map<string, Project>();
  for (const project of projectRows) {
    projectMap.set(project.id, project);
  }

  // Batch-load the owners of the loaded projects so we can skip domains whose
  // owner is ADMIN-suspended. The authenticated `void domain status` route is
  // behind authMiddleware, which 403s admin-suspended owners; the cron must
  // match that — it should never advance a domain the authed path would
  // refuse. Usage-suspended owners (isAdminSuspended === false) are NOT skipped
  // — they retain access and their domains must still reconcile.
  const ownerIds = [...new Set(projectRows.map((p) => p.user_id))];
  const owners = await getUsersByIds(db, ownerIds);
  const suspendedOwnerIds = new Set(
    owners.filter((u) => isAdminSuspended(u.suspended_reason)).map((u) => u.id),
  );

  let activated = 0;
  for (const domain of pending) {
    const project = projectMap.get(domain.project_id);
    if (!project) {
      // Defensive: orphaned domain row with no project.
      console.error(
        `[scheduled] reconcile: project ${domain.project_id} not found for domain ${domain.hostname} — skipping`,
      );
      continue;
    }
    if (suspendedOwnerIds.has(project.user_id)) {
      // Expected, not an error: the owner is admin-suspended, so the cron must
      // not activate their domain (parity with the 403 the authed status route
      // returns). No error log.
      continue;
    }
    try {
      const result = await tryActivateDomain(env, db, domain, project, { retriggerDcv });
      if (result.activated) {
        activated += 1;
      }
    } catch (err) {
      console.error('[scheduled] failed to reconcile pending domain ' + domain.hostname + ':', err);
    }
  }

  if (activated > 0) {
    console.log(
      '[scheduled] auto-activated ' + activated + '/' + pending.length + ' pending domain(s)',
    );
  }
}

// Resolve the `proxyToken` to write into a `queue:<name>` route for the
// CURRENT active worker, mirroring `resolveRollbackProxyToken` in
// `routes/projects.ts` (which we do NOT import — the low-level
// `getDispatchWorkerProxyToken` is called directly here to keep the same
// semantics without a cross-route dependency).
//
// The user worker validates the queue token by EXACT string-compare against its
// own baked `__VOID_PROXY_TOKEN` binding, frozen at the worker's deploy time. A
// blind `hmacSignState(projectId, JWT_SECRET)` recompute would mismatch — and
// 401 the worker into an infinite `batch.retryAll()` — if `JWT_SECRET` rotated
// after that deploy. So:
//   - `found`   → use the baked token as-is.
//   - `missing` → legacy worker with no baked binding; re-derive from the
//                 current secret with a WARNING (safe only if the secret has not
//                 rotated since this deploy — matches resolveRollbackProxyToken).
//   - `error`   → transient CF failure; THROW so the caller's tx aborts and the
//                 row is left UNMARKED (retried next run). Never write a guessed
//                 token that would 401 the worker indefinitely.
async function resolveQueueProxyToken(
  env: ApiEnv['Bindings'],
  workerName: string,
  projectId: string,
): Promise<string> {
  const dispatchNamespace = env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const lookup = await getDispatchWorkerProxyToken(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    dispatchNamespace,
    workerName,
  );
  if (lookup.kind === 'found') {
    return lookup.token;
  }
  if (lookup.kind === 'error') {
    throw new Error(
      `live-routing reconcile: could not read __VOID_PROXY_TOKEN from worker "${workerName}": ${lookup.error.message}`,
    );
  }
  // lookup.kind === 'missing' — legacy worker.
  console.warn(
    `[scheduled] live-routing reconcile: worker "${workerName}" has no __VOID_PROXY_TOKEN binding; falling back to current-secret derivation. If JWT_SECRET has rotated since this deployment was live, you must redeploy the project instead.`,
  );
  return hmacSignState(projectId, env.JWT_SECRET);
}

// Republish ALL post-go-live routing KV for active deployments that are NOT
// yet marked `routing_published`. Closes a gap left by the
// routing-after-tx reorder: a deploy can commit live (DB `active_deployment_id`
// flipped) yet fail to publish routing KV after the in-request retries are
// exhausted (e.g. a transient KV error). The slug is the FIRST key written, so
// inferring health from the slug entry alone would leave a
// slug-success-but-later-key-failure (account/domain/queue/asset metadata)
// unhealed forever. The durable `routing_published` marker — set only on a FULL
// publish success — is the sole health predicate instead. On a FIRST deploy a
// missing slug also leaves the project UNREACHABLE (dispatch routes purely from
// ROUTING KV and never reads `active_deployment_id` for traffic).
//
// Every selected row gets an UNCONDITIONAL full rebuild — slug, account, every
// active domain, queue consumers, and the WfP asset-fallback metadata — written
// byte-identically to the deploy path, then the marker is set so the row
// converges (next run filters it out by the query). Pre-existing NULL-marker
// rows are backfilled once within the recency window.
//
// CONCURRENCY (the stale-snapshot clobber). The query SELECTs a snapshot of
// active deployments once, then heals each row from that snapshot. A concurrent
// deploy can commit + flip `active_deployment_id` to a NEWER deployment between
// the SELECT and a row's KV writes; replaying the OLD snapshot's routing would
// clobber the newer live deployment's slug/domain routes (dispatch routes purely
// from these KV values) and stamp the stale row published so it never repairs.
// To stay symmetric with the deploy go-live tx (which takes `SELECT id FROM
// projects ... FOR UPDATE`, commits the pointer flip, THEN publishes routing
// lock-free), each row's heal runs inside a tx that takes the SAME project-row
// `FOR UPDATE` lock and RE-READS `active_deployment_id`. The KV puts + marker run
// ONLY if it still equals the snapshot's `deploymentId`; otherwise the row is
// SKIPPED (a newer deploy owns routing and has/will publish it, and the stale row
// self-excludes from the next query since it is no longer the active deployment).
// The lock is held across the KV puts + the mark so a concurrent deploy's FOR
// UPDATE serializes behind it. After the matching re-read the snapshot's
// manifest/slug/assetHashes are still valid (same deployment ⇒ same data), so no
// re-fetch is needed. The reconciler never writes anything but the CURRENT active
// deployment's routing (or nothing) — it introduces no pre-commit routing write
// (there is no deploy tx here; it is a lock + re-check around idempotent KV
// overwrites).
//
// Queue routes ARE reconciled here. A `queue:<name>` route embeds a `proxyToken`
// that the user worker validates by EXACT string-compare against its own baked
// `__VOID_PROXY_TOKEN` binding, frozen at the worker's deploy time. Recomputing
// `hmacSignState(projectId, JWT_SECRET)` would mismatch (→ worker 401 →
// `retryAll()` forever) if `JWT_SECRET` rotated after that deploy, so the token
// is sourced from the worker's BAKED binding via `getDispatchWorkerProxyToken`,
// mirroring `resolveRollbackProxyToken` (found → baked; missing → warned legacy
// re-derivation; error → leave the row unmarked to retry, never guess). Healing
// slug+account+domain also transitively unblocks a stuck custom domain via the
// existing `reconcilePendingDomains` activation gate (which requires live slug
// routing).
async function reconcileLiveRouting(
  env: ApiEnv['Bindings'],
  db: Db,
  scheduledTime: number,
): Promise<void> {
  const nowMs = Number.isFinite(scheduledTime) ? scheduledTime : Date.now();
  const sinceIso = new Date(nowMs - RECONCILE_LIVE_ROUTING_WINDOW_MS).toISOString();
  const rows = await getRecentlyLiveActiveDeployments(
    db,
    sinceIso,
    MAX_LIVE_ROUTING_RECONCILE_PER_RUN,
  );
  if (rows.length === 0) {
    return;
  }
  if (rows.length === MAX_LIVE_ROUTING_RECONCILE_PER_RUN) {
    console.warn(
      `[scheduled] live-routing reconcile hit the per-run cap (${MAX_LIVE_ROUTING_RECONCILE_PER_RUN}); remaining recently-live deployments will be processed on the next run`,
    );
  }

  // Batch-load owners for the deduped user set so we can derive each project's
  // plan (dispatch limits + the account entry's `plan`) without a per-row query.
  const ownerIds = [...new Set(rows.map((r) => r.userId))];
  const owners = await getUsersByIds(db, ownerIds);
  const planByUserId = new Map(owners.map((u) => [u.id, u.plan]));

  // F5: per-run cap-starvation risk is accepted/deferred. Rows whose pointer
  // moved are SKIPPED and self-exclude from the next query (no longer active), so
  // they do not accumulate. The only rows that can stay persistently unmarked are
  // genuinely-unhealable active ones — in practice just the persistent-queue-token
  // -error class (a per-worker CF fault while resolving the baked token in F2),
  // which is bounded per worker, not fleet-wide. A >200 simultaneous backlog of
  // such rows is not a credible operational state, so no schema column is added to
  // bound it; the oldest-first ordering + recency window keep the residual benign.
  // The cap-warning log above is the operational signal: if a real backlog is ever
  // observed, the minimal fix is raising MAX_LIVE_ROUTING_RECONCILE_PER_RUN (a
  // constant, no schema). Every per-row failure/skip is logged and never aborts the
  // batch.
  let healed = 0;
  for (const row of rows) {
    try {
      // The `routing_published` marker (via the query filter) already selected
      // only genuinely-unpublished rows, so there is no fast-path skip — every
      // row gets an UNCONDITIONAL full rebuild. Read the existing slug entry only
      // to preserve any `suspended` marker (parity with the deploy path, which
      // carries `existingEntry?.suspended` forward). This KV read is lock-free
      // and outside the per-row tx — it does not need the project lock and keeps
      // the FOR UPDATE window tight.
      const raw = await env.ROUTING.get(row.slug);
      const parsed = raw ? JSON.parse(raw) : null;

      // Rebuild the routing JSON exactly as deploy/rollback do from the active
      // deployment's manifest.
      const manifest: DeployManifest | null = row.manifest ? JSON.parse(row.manifest) : null;
      const plan = planByUserId.get(row.userId) ?? 'free';
      const isStatic = row.type === 'static' || row.type === 'spa';

      let routingJson: string;
      const workerName = getProjectDeploymentWorkerName(row.slug, row.deploymentId);
      if (isStatic) {
        const assetConfig = manifest?.assetConfig ?? {
          not_found_handling: row.type === 'spa' ? 'single-page-application' : '404-page',
        };
        routingJson = buildStaticRoutingJson({
          projectId: row.projectId,
          userId: row.userId,
          deploymentId: row.deploymentId,
          assetConfig,
          manifest,
          suspended: parsed?.suspended,
        });
      } else {
        const planLimits = getPlanLimits(plan);
        const dispatchLimits =
          planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
            ? {
                ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
                ...(planLimits.subRequestsPerInvocation > 0
                  ? { subRequests: planLimits.subRequestsPerInvocation }
                  : {}),
              }
            : null;
        // WfP asset-fallback metadata. `asset_hashes != null` is the exact proxy
        // for the deploy path's `assetCount > 0` gate (deploy.ts only writes
        // `asset_hashes` inside `if (assetCount > 0)`), and `buildRoutingJson`
        // appends these fields last, so field order stays byte-identical.
        const hasAssets = row.assetHashes != null;
        routingJson = buildRoutingJson({
          workerName,
          projectId: row.projectId,
          userId: row.userId,
          manifest,
          deploymentId: row.deploymentId,
          dispatchLimits,
          suspended: parsed?.suspended,
          hasCrons: !!manifest?.schedules?.length,
          assetManifestId: hasAssets ? row.deploymentId : undefined,
          assetConfig: hasAssets
            ? (manifest?.assetConfig ?? { not_found_handling: 'none' })
            : undefined,
        });
      }

      // F1: heal under the SAME project-row FOR UPDATE lock the deploy go-live
      // tx and the primary publishers take, then RE-READ `active_deployment_id`
      // and proceed ONLY if it still equals this snapshot's deployment. A
      // concurrent deploy that flipped the pointer between the snapshot SELECT
      // and now owns routing — replaying the stale snapshot would clobber the
      // newer live deployment's routes. `publishRoutingIfStillActive` holds the
      // lock across the KV puts + the mark so a concurrent deploy's FOR UPDATE
      // serializes behind it (one uniform lock+re-check used by deploy, rollback,
      // and this reconciler).
      // The pointer still matches the snapshot ⇒ snapshot data is current.
      // Idempotent overwrite: slug route, the per-project account entry (the
      // rollback path omits this — it is covered here), every active custom
      // domain's route, and (WfP only) the queue routes.
      const publishRow = async (txDb: Db): Promise<void> => {
        // RE-READ the current slug entry's `suspended` marker UNDER THE LOCK and
        // fold it into the rebuilt JSON. `routingJson` was built from a PRE-LOCK
        // snapshot of `suspended` (read outside the per-row tx); a guarded
        // suspension (`guardedRoutingKvRmw`) can serialize FIRST and stamp
        // `suspended` onto the slug route, and writing the stale snapshot here
        // would drop that marker. The corrected JSON flows into BOTH the slug
        // write and the domain writes below.
        const slugJson = await applyCurrentSuspension(env.ROUTING, row.slug, routingJson);
        await env.ROUTING.put(row.slug, slugJson);
        await writeProjectAccountEntry(env.ROUTING, row.projectId, row.userId, plan);
        // Re-read active domains UNDER THE LOCK (via the lock-tx handle), not
        // from a pre-publish snapshot, so a concurrent domain activate/delete
        // cannot strand a newly-active domain or recreate a deleted one. Mirrors
        // the deploy/rollback publishers.
        const projectDomains = await getDomainsByProjectId(txDb, row.projectId);
        for (const domain of projectDomains) {
          if (domain.status === 'active') {
            await env.ROUTING.put(`domain:${domain.hostname}`, slugJson);
          }
        }

        // Queue routes (WfP only). The deploy path writes one `queue:<name>`
        // entry per manifest queue with the same shape — `getProjectQueueName`
        // matches the provisioned `queue_name`. F2: the `proxyToken` MUST be the
        // worker's BAKED `__VOID_PROXY_TOKEN`, which the user worker validates by
        // exact string-compare. Recomputing `hmacSignState` would 401 the worker
        // if `JWT_SECRET` rotated after its deploy. Resolve from the worker's
        // baked binding, mirroring `resolveRollbackProxyToken`'s found/missing/
        // error handling. Resolve once per row (hoisted out of the queue loop).
        // EXPECTED queue-route keys for the active manifest. Built from the
        // same `getProjectQueueName` the deploy/rollback paths use so the key
        // shape (`queue:<projectId>-<name>` lowercased, `_`→`-`) matches the
        // provisioned `queue_name` exactly. A static active deployment (or one
        // that became static via rollback) binds NO queues and has NO consumer
        // worker, so its expected set is EMPTY — the sweep below drops every
        // `queue:<projectId>-` route. The queue-route WRITES stay WfP-only
        // (static targets have no worker to dispatch to).
        const expectedQueueKeys = new Set<string>();
        if (!isStatic) {
          const queues = manifest?.queues ?? [];
          for (const q of queues) {
            expectedQueueKeys.add(`queue:${getProjectQueueName(row.projectId, q.name)}`);
          }
          if (queues.length > 0) {
            const proxyToken = await resolveQueueProxyToken(env, workerName, row.projectId);
            for (const q of queues) {
              await env.ROUTING.put(
                `queue:${getProjectQueueName(row.projectId, q.name)}`,
                JSON.stringify({
                  workerName,
                  projectId: row.projectId,
                  queueName: q.name,
                  proxyToken,
                }),
              );
            }
          }
        }
        // Delete-sweep (mirrors rollback's post-commit sweep in
        // `routes/projects.ts`). Rollback's post-commit publish can fail
        // BEFORE/DURING its own sweep, leaving the active target unmarked with
        // a stale `queue:<projectId>-<oldName>` route from a previous
        // deployment still live in KV — dispatch would relay that queue's
        // batches to the now-evicted worker. The reconciler heals the active
        // manifest's queues above, but must ALSO drop queue routes the active
        // deployment no longer binds, or the stale route survives hidden behind
        // `routing_published=true` (the row never re-selects). Runs
        // UNCONDITIONALLY — for a static active deployment the expected set is
        // empty, so every `queue:<projectId>-` route is swept (a static target
        // binds zero queues). Runs under the same active-pointer lock as the
        // writes above (inside this guarded publish callback) via the shared
        // `sweepStaleQueueRoutes`.
        await sweepStaleQueueRoutes(env.ROUTING, row.projectId, expectedQueueKeys);
      };
      // 'superseded' → a newer deploy owns routing (or the project lost this
      // deployment as active): the stale row self-excludes from the next query.
      // 'failed' → a put threw; the row stays unmarked and retries next run.
      const outcome = await publishRoutingIfStillActive(
        db,
        row.projectId,
        row.deploymentId,
        publishRow,
      );
      if (outcome === 'superseded') {
        console.log(
          `[scheduled] live-routing reconcile skipped slug ${row.slug}: deployment ${row.deploymentId} is no longer active (a newer deploy owns routing)`,
        );
        continue;
      }
      if (outcome === 'failed') {
        // A put threw inside the helper. Mirror the prior per-row failure path:
        // log and move on (the row stays unmarked → healed next run). Throw so
        // the surrounding catch logs the project context uniformly.
        throw new Error(`routing publish failed for slug ${row.slug}`);
      }
      healed += 1;
      console.log(
        `[scheduled] live-routing reconcile healed slug ${row.slug} -> deployment ${row.deploymentId}`,
      );
    } catch (err) {
      // Per-row isolation: a single bad row (e.g. an unparseable manifest) must
      // never abort the batch (parity with reconcilePendingDomains).
      console.error(
        `[scheduled] failed to reconcile live routing for project ${row.projectId} (slug ${row.slug}):`,
        err,
      );
    }
  }

  if (healed > 0) {
    console.log(`[scheduled] live-routing reconcile healed ${healed}/${rows.length} project(s)`);
  }
}

// Exported for direct integration testing of the janitor branch in isolation
// from the reconcile pass (the hourly `scheduled()` runs reconcile first, which
// would otherwise activate any gate-passing pending domain before the janitor
// sees it — masking the >200-backlog starvation path the janitor now handles).
export async function cleanupStalePendingDomains(
  env: ApiEnv['Bindings'],
  db: Db,
  nowMs: number,
): Promise<void> {
  const cutoff = new Date(nowMs - PENDING_DOMAIN_MAX_AGE_MS).toISOString();
  const stale = await getPendingDomainsOlderThan(db, cutoff, MAX_PENDING_RECONCILE_PER_RUN);
  if (stale.length === MAX_PENDING_RECONCILE_PER_RUN) {
    console.warn(
      `[scheduled] stale pending-domain cleanup hit the per-run cap (${MAX_PENDING_RECONCILE_PER_RUN}); remaining stale domains will be processed on the next run`,
    );
  }
  if (stale.length === 0) {
    return;
  }

  let cleaned = 0;
  for (const domain of stale) {
    // The `stale` snapshot can be racy: a user may finish DNS on day 8, or a
    // concurrent `void domain status` poll may activate the domain between the
    // snapshot and now. Re-check CF live before tearing anything down so we
    // never delete a hostname that has since verified.
    let live;
    try {
      live = await getCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);
    } catch (err) {
      // CF already removed the hostname (e.g. its own 7-day validation
      // cleanup). Nothing to revoke — fall through to drop the orphaned DB row
      // (and any stray KV) so the customer can re-add the hostname.
      if (err instanceof CloudflareApiError && err.status === 404) {
        await env.ROUTING.delete(`domain:${domain.hostname}`).catch(() => {});
        if (await deleteDomainIfPending(db, domain.id)) {
          cleaned += 1;
        }
        continue;
      }
      console.error(`[scheduled] failed to read stale CF hostname for ${domain.hostname}:`, err);
      continue;
    }

    // Ownership completed since the snapshot — never delete a verified host.
    // We don't merely skip here: under a sustained >MAX_PENDING_RECONCILE_PER_RUN
    // backlog, the oldest-first reconcile cap can starve a verified-but-pending
    // domain that has aged past 7 days into this janitor, leaving it unrouted
    // indefinitely. Opportunistically run the shared activation gate so it comes
    // online, while preserving reconcile's admin-suspended-owner skip parity (the
    // authed status route 403s admin-suspended owners; the cron must match).
    if (live.status === 'active') {
      const project = await getProject(db, domain.project_id);
      if (!project) {
        // Defensive: orphaned domain row with no project. Never delete a
        // verified host — leave the row for ops/manual cleanup.
        continue;
      }
      const [owner] = await getUsersByIds(db, [project.user_id]);
      if (owner && isAdminSuspended(owner.suspended_reason)) {
        // Owner is admin-suspended — parity with reconcile and the authed
        // status route's 403. Do not activate; never delete a verified host.
        continue;
      }
      try {
        await tryActivateDomain(env, db, domain, project);
      } catch (err) {
        console.error(
          `[scheduled] failed to activate verified stale domain ${domain.hostname}:`,
          err,
        );
      }
      continue;
    }

    // Still genuinely pending. Claim the row FIRST via a conditional delete:
    // if a concurrent poll has activated it, this no-ops and we skip teardown,
    // so we never revoke the cert of a live domain.
    if (!(await deleteDomainIfPending(db, domain.id))) {
      continue;
    }

    // Row claimed — revoke the CF cert order (treat an already-gone 404 as
    // success) and drop any routing entry a racing activation may have written.
    // The DB row is already deleted, so a non-404 CF failure orphans the CF
    // hostname (cert order stays open). Retry the DELETE ONCE to shrink that
    // orphan window — no backoff/sleep (cron context). If the retry also fails
    // non-404, log an error explicitly noting the orphan so ops can detect it.
    try {
      await deleteCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);
    } catch (err) {
      if (!(err instanceof CloudflareApiError && err.status === 404)) {
        try {
          await deleteCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);
        } catch (retryErr) {
          if (!(retryErr instanceof CloudflareApiError && retryErr.status === 404)) {
            console.error(
              `[scheduled] failed to delete stale CF hostname for ${domain.hostname} after retry — CF hostname ${domain.cf_hostname_id} is ORPHANED (DB row already removed):`,
              retryErr,
            );
          }
        }
      }
    }
    await env.ROUTING.delete(`domain:${domain.hostname}`).catch(() => {});
    cleaned += 1;
  }

  if (cleaned > 0) {
    console.log(`[scheduled] cleaned up ${cleaned} stale pending domain(s)`);
  }
}

async function processUserRollover(
  env: ApiEnv['Bindings'],
  db: Db,
  user: { id: string; plan: string; billing_cycle_start: string; suspended_reason: string | null },
  userProjects: ReadonlyArray<{ id: string; slug: string }>,
): Promise<void> {
  // Backfill userId into old KV routing entries (all plans, before early return).
  // Wrapped in try/catch so a malformed KV entry doesn't block rollover/unsuspension.
  try {
    for (const project of userProjects) {
      const raw = await env.ROUTING.get(project.slug);
      if (!raw) {
        continue;
      }
      const routing = JSON.parse(raw);
      if (routing.userId) {
        continue;
      }
      // Lock-guarded RMW: this is a legacy-entry backfill (every current writer
      // — deploy/rollback/reconciler — already includes `userId`), but read +
      // write are NOT atomic. A concurrent deploy/rollback publishing a NEW slug
      // route in the window between the read above and the write would be
      // clobbered (and since the newer active is `routing_published=true`, the
      // reconciler — which only heals unpublished rows — never heals it). Take
      // the SAME project FOR UPDATE lock the publishers take, RE-READ the entry
      // under the lock, and backfill ONLY if `userId` is STILL absent. A
      // concurrent publish either committed before this lock (re-read sees its
      // `userId` → no-op, its route survives) or serializes behind this short
      // RMW (then overwrites it). The KV put nests no pg write — same shape as
      // the reconciler's lock + KV publish.
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockProjectAndGetActiveDeploymentId(txDb, project.id);
        const lockedRaw = await env.ROUTING.get(project.slug);
        if (!lockedRaw) {
          return;
        }
        const lockedRouting = JSON.parse(lockedRaw);
        if (lockedRouting.userId) {
          return;
        }
        lockedRouting.userId = user.id;
        await env.ROUTING.put(project.slug, JSON.stringify(lockedRouting));
      });
    }

    // Also backfill domain:* entries — check all projects, not just those that needed
    // slug backfill (slug may have been patched in a prior run before domain support).
    const projectIds = userProjects.map((p) => p.id);
    if (projectIds.length > 0) {
      const domainMap = await getDomainsByProjectIds(db, projectIds);
      for (const projectId of projectIds) {
        const projectDomains = domainMap.get(projectId);
        if (!projectDomains) {
          continue;
        }
        for (const domain of projectDomains) {
          if (domain.status !== 'active') {
            continue;
          }
          const raw = await env.ROUTING.get(`domain:${domain.hostname}`);
          if (!raw) {
            continue;
          }
          const routing = JSON.parse(raw);
          if (routing.userId) {
            continue;
          }
          // Lock-guarded RMW — same rationale as the slug backfill above: take
          // the project FOR UPDATE lock, RE-READ the `domain:*` entry under the
          // lock, and backfill ONLY if `userId` is STILL absent, so a concurrent
          // deploy/rollback publishing this domain route is not clobbered.
          await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            await lockProjectAndGetActiveDeploymentId(txDb, projectId);
            const lockedRaw = await env.ROUTING.get(`domain:${domain.hostname}`);
            if (!lockedRaw) {
              return;
            }
            const lockedRouting = JSON.parse(lockedRaw);
            if (lockedRouting.userId) {
              return;
            }
            lockedRouting.userId = user.id;
            await env.ROUTING.put(`domain:${domain.hostname}`, JSON.stringify(lockedRouting));
          });
        }
      }
    }
  } catch (err) {
    console.error(`[backfill] userId backfill failed for user ${user.id}:`, err);
  }

  const limits = getPlanLimits(user.plan);
  // Skip unlimited plans (no enforcement needed)
  if (limits.requestsPerMonth === 0 && limits.aiNeuronsPerMonth === 0) {
    return;
  }
  if (userProjects.length === 0) {
    return;
  }

  const billingPeriodStart = getCurrentBillingPeriodStart(user.billing_cycle_start).toISOString();
  const projectSlugs: Record<string, string> = {};
  for (const p of userProjects) {
    projectSlugs[p.id] = p.slug;
  }

  const doId = env.USAGE_COUNTER.idFromName(user.id);
  const stub = env.USAGE_COUNTER.get(doId);

  // Send rollover check (DO only resets if period actually changed).
  // The DO does the sandbox-block KV delete + sandbox_runtime DB unsuspend
  // inline because it owns that state; request-suspension cleanup stays here
  // because the DO doesn't know which project slugs were marked suspended.
  const rolloverRes = await stub.fetch(
    new Request('https://do/rollover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billingPeriodStart, plan: user.plan, userId: user.id }),
    }),
  );

  if (rolloverRes.ok) {
    const result = await rolloverRes.json<{
      rolled: boolean;
      unsuspendRequests?: boolean;
      unsuspendAi?: boolean;
      requestsSuspended?: boolean;
    }>();

    if (result.rolled && result.unsuspendRequests) {
      // DB side of the request-cap unsuspend. Match-guarded, so it's a no-op if
      // a later sandbox suspension overwrote `suspended_reason` (the DO latch,
      // not the DB reason, is the authority for the KV reconcile below).
      await unsuspendUserIfReason(db, user.id, REASON_REQUESTS_EXCEEDED);
    }

    // KV side, EVERY pass: reconcile the `suspended` marker on slug + active
    // `domain:<host>` routes against the DO's authoritative request latch. When
    // the user is not request-suspended, clear any lingering `requests_exceeded`
    // marker (reason-scoped — never lifts an admin suspension). The DO resets
    // its latch on rollover but cannot clear KV (it lacks the project + domain
    // list). Running this every pass — not just on the rollover pass — makes the
    // cleanup self-healing: a partial KV-write failure is retried next run
    // instead of stranding routes at 429 until the next deploy. This mirrors the
    // DO `/init` re-stamp, which already re-applies the marker every pass while
    // the latch is true. (`undefined` from an old DO during a deploy: skipped,
    // and reconciled on the next pass once the DO is updated.)
    if (result.requestsSuspended === false) {
      await setProjectsRoutingSuspension(env.ROUTING, db, userProjects, {
        op: 'unsuspend',
        matchReason: REASON_REQUESTS_EXCEEDED,
      });
    }
  }

  // Initialize DO with current project slugs (handles new users/projects)
  await stub.fetch(
    new Request('https://do/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: user.plan, billingPeriodStart, projectSlugs }),
    }),
  );
}

export { UsageCounter, CronScheduler, ErrorAlertMonitor, SandboxConcurrencyCounter };
export type AppType = typeof app;
export { app, scheduled };

export default {
  fetch: app.fetch,
  scheduled,
  async queue(batch: MessageBatch<unknown>, env: ApiEnv['Bindings']): Promise<void> {
    // Dispatch by queue name. void-api consumes two queues:
    // - `void-usage-events` (and `*-staging`): per-request usage rollup
    // - `void-cron-fires` (and `*-staging`): cron-trigger invocations from
    //   the CronScheduler DO, deferred here so the dispatched fetch runs
    //   outside the DO's RPC context.
    if (batch.queue.startsWith('void-cron-fires')) {
      await processCronFiresBatch(batch as unknown as MessageBatch<CronFireMessage>, env);
      return;
    }
    await processUsageEventBatch(batch, env);
  },
} satisfies ExportedHandler<ApiEnv['Bindings']>;
