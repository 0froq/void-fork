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
import { type CronFireMessage, processCronFiresBatch } from './cron-fires-queue.ts';
import { CronScheduler } from './cron-scheduler.ts';
import {
  createDb,
  getUsersWithProjectsBatch,
  unsuspendUserIfReason,
  getDomainsByProjectIds,
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
  type Db,
} from './db.ts';
import { escapeHtml } from './email.ts';
import type { ApiEnv } from './env.ts';
import { ErrorAlertMonitor } from './error-alert-monitor.ts';
import { authMiddleware } from './middleware/auth.ts';
import { tryActivateDomain } from './provisioning/activate-domain.ts';
import {
  CloudflareApiError,
  deleteCustomHostname,
  getCustomHostname,
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
import { SandboxConcurrencyCounter } from './sandbox-concurrency-counter.ts';
import { isAdminSuspended, REASON_REQUESTS_EXCEEDED } from './suspension.ts';
import { getCurrentBillingPeriodStart, getPlanLimits } from './tiers.ts';
import type { Domain, Project } from './types.ts';
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
      if (!routing.userId) {
        routing.userId = user.id;
        await env.ROUTING.put(project.slug, JSON.stringify(routing));
      }
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
          if (!routing.userId) {
            routing.userId = user.id;
            await env.ROUTING.put(`domain:${domain.hostname}`, JSON.stringify(routing));
          }
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
    }>();

    if (result.rolled && result.unsuspendRequests) {
      await unsuspendUserIfReason(db, user.id, REASON_REQUESTS_EXCEEDED);
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
