import {
  getDomainsByProjectIds,
  getProjectsByUserId,
  getUser,
  lockProjectAndGetActiveDeploymentId,
  type Db,
} from './db.ts';
import { getProjectQueueName } from './naming.ts';
import type { AssetConfig, DeployManifest } from './types.ts';

/**
 * Delete every `queue:<projectId>-<name>` routing entry that is NOT in
 * `expectedQueueKeys`, so a deploy/rollback that DROPS a queue binding (or a
 * project that goes static and binds no queues) leaves no stale queue route
 * dispatching batches to a dead/old worker.
 *
 * The prefix is derived through `getProjectQueueName(projectId, '')` (NOT a raw
 * `queue:${projectId}-`) so the projectId segment is lowercased / `_`→`-`
 * IDENTICALLY to the stored keys — a raw prefix would MISS keys when the
 * projectId contains uppercase or `_` characters. `list({ prefix })` is
 * paginated via the cursor; KV delete on a missing key is a no-op so this is
 * idempotent/retry-safe.
 *
 * This is the single reference implementation shared by the deploy publish
 * closures, the rollback publish closure, and the hourly reconciler. Callers
 * that want to drop ALL queue routes (e.g. a static deploy) pass an empty
 * `expectedQueueKeys`.
 *
 * Under the routing-after-tx model a `queue:<name>` route is written ONLY by a
 * publish closure AFTER its deployment goes live (deploy/rollback/reconciler),
 * never before. So an in-flight (non-terminal) deployment has NO route in KV at
 * sweep time — callers pass ONLY their own/target manifest's queue keys and do
 * NOT union any in-flight set. An in-flight deploy that the sweep "misses" (it
 * had no route to begin with) republishes its own queue routes when it goes
 * live, so a concurrent cutover dropping a not-yet-owned route causes no harm.
 */
export async function sweepStaleQueueRoutes(
  routing: KVNamespace,
  projectId: string,
  expectedQueueKeys: ReadonlySet<string>,
): Promise<void> {
  const queuePrefix = `queue:${getProjectQueueName(projectId, '')}`;
  let cursor: string | undefined;
  do {
    const listed = await routing.list({
      prefix: queuePrefix,
      ...(cursor ? { cursor } : {}),
    });
    for (const { name } of listed.keys) {
      if (!expectedQueueKeys.has(name)) {
        await routing.delete(name);
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

/**
 * KV key + payload shape for the per-project routing entry consumed by the
 * proxy's `/sandbox/acquire` lookup (`packages/proxy/src/sandbox.ts`). The
 * proxy parses `{ userId, plan }` to resolve the sandbox concurrency cap +
 * runtime-block lookup for the authenticated `projectId`. Field casing is
 * camelCase to match the rest of the routing-entry conventions in this
 * module — `buildRoutingJson` and `buildStaticRoutingJson` both emit
 * `projectId` / `userId`.
 */
export type ProjectAccountEntry = Readonly<{
  userId: string;
  plan: string;
}>;

export function projectAccountKey(projectId: string): string {
  return `project:${projectId}`;
}

export function sandboxBlockKey(userId: string): string {
  return `sandbox-block:${userId}`;
}

export function buildProjectAccountJson(entry: ProjectAccountEntry): string {
  return JSON.stringify({ userId: entry.userId, plan: entry.plan });
}

/**
 * Write the per-project routing entry the proxy's sandbox gate reads.
 * Called from every deploy's routing-switch step so a plan-change picked up
 * by `provisionBindings` propagates to the proxy without a separate write.
 */
export async function writeProjectAccountEntry(
  routing: KVNamespace,
  projectId: string,
  userId: string,
  plan: string,
): Promise<void> {
  await routing.put(projectAccountKey(projectId), buildProjectAccountJson({ userId, plan }));
}

/**
 * Re-publish every `project:{projectId}` routing entry for `userId`. Invoked
 * after a plan-change so the proxy's sandbox gate sees the new concurrency
 * cap on the next acquire without waiting for the user to redeploy. Best-
 * effort: KV writes are idempotent and bounded by the user's project count,
 * but a failure here means stale plan data lives in KV until the next deploy
 * for that project — callers should log on failure.
 */
export async function refreshProjectKvForUser(
  db: Db,
  routing: KVNamespace,
  userId: string,
): Promise<void> {
  const user = await getUser(db, userId);
  if (!user) {
    return;
  }
  const projects = await getProjectsByUserId(db, userId);
  if (projects.length === 0) {
    return;
  }
  const payload = buildProjectAccountJson({ userId, plan: user.plan });
  await Promise.all(projects.map((project) => routing.put(projectAccountKey(project.id), payload)));
}

/**
 * Re-read the CURRENT slug routing entry's `suspended` marker and fold it into a
 * prebuilt routing JSON, so a publisher carries whatever suspension state exists
 * UNDER THE LOCK instead of its pre-lock snapshot.
 *
 * Publishers (deploy static/WfP, rollback, reconciler) build `prebuiltJson` with
 * `suspended` read BEFORE taking the publish lock. A guarded admin/UsageCounter
 * suspension (`guardedRoutingKvRmw`) can serialize FIRST and stamp `suspended`
 * onto the slug route — then the publisher would overwrite it with the stale
 * pre-lock JSON that lacks the marker, and dispatch (which enforces suspension
 * from `routing.suspended`) keeps serving a suspended/over-limit project until
 * some unrelated mutation re-stamps it. Hidden behind `routing_published=true`,
 * the reconciler never heals it.
 *
 * Call this INSIDE the publish closure (under the project lock) for the slug
 * route, and reuse the returned JSON for the `domain:<host>` writes too — the
 * domain payload must carry the same corrected `suspended`. Reads the FRESH slug
 * entry via `routing.get` (the publishers already nest KV reads under the lock),
 * parses the prebuilt JSON, and sets `suspended` to the slug entry's current
 * value (or removes it when the slug entry has none / is absent). Returns
 * `prebuiltJson` byte-identical when nothing changed.
 */
export async function applyCurrentSuspension(
  routing: KVNamespace,
  slug: string,
  prebuiltJson: string,
): Promise<string> {
  const currentRaw = await routing.get(slug);
  const currentSuspended =
    currentRaw !== null ? (JSON.parse(currentRaw) as { suspended?: unknown }).suspended : undefined;
  const parsed = JSON.parse(prebuiltJson) as Record<string, unknown>;
  const prebuiltSuspended = parsed.suspended;
  if (currentSuspended === prebuiltSuspended) {
    return prebuiltJson;
  }
  if (typeof currentSuspended === 'string' && currentSuspended.length > 0) {
    parsed.suspended = currentSuspended;
  } else {
    delete parsed.suspended;
  }
  return JSON.stringify(parsed);
}

/**
 * A reason-aware mutation of the `suspended` marker on a routing KV entry.
 *
 * The `suspended` field is shared by two unrelated suspension sources with a
 * precedence rule: an admin suspension (`admin_suspended` / a custom reason)
 * outranks an automatic usage suspension (`requests_exceeded`). Usage paths
 * must therefore NEVER clobber an admin marker, while admin actions are
 * authoritative and overwrite/clear anything. The discriminant encodes that:
 *
 *  - `{ op: 'suspend', reason, force }` — set `suspended = reason`. `force`
 *    (admin) overwrites a different existing reason; non-`force` (usage) only
 *    stamps when no marker exists, so it can't downgrade an admin suspension.
 *  - `{ op: 'unsuspend', matchReason }` — clear the marker. `matchReason: null`
 *    (admin) clears any reason; a string (usage) clears ONLY when the existing
 *    marker equals it, so a usage clear can't lift an admin suspension.
 */
export type RoutingSuspensionUpdate =
  | { op: 'suspend'; reason: string; force: boolean }
  | { op: 'unsuspend'; matchReason: string | null };

/**
 * Apply a {@link RoutingSuspensionUpdate} to each given routing KV entry. A
 * project's suspension lives on EVERY routing entry dispatch serves it from —
 * its slug route AND one `domain:<host>` route per active custom domain — so
 * callers pass the full key set (see {@link setProjectsRoutingSuspension}).
 *
 * Skips keys with no entry (a pending domain has no KV route yet; a slug may be
 * mid-deploy), and skips the write whenever the entry already satisfies the
 * update (set → same reason / weaker reason preserved, clear → no matching
 * marker) so repeated suspend/unsuspend is a cheap no-op.
 */
export async function applyRoutingSuspension(
  routing: KVNamespace,
  keys: ReadonlyArray<string>,
  update: RoutingSuspensionUpdate,
): Promise<void> {
  for (const key of keys) {
    const raw = await routing.get(key);
    if (!raw) {
      continue;
    }
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (update.op === 'suspend') {
      if (entry.suspended === update.reason) {
        continue; // already carries this reason
      }
      if (!update.force && entry.suspended) {
        continue; // usage suspend must not overwrite a stronger (admin) reason
      }
      entry.suspended = update.reason;
    } else {
      if (!('suspended' in entry)) {
        continue; // nothing to clear
      }
      if (update.matchReason !== null && entry.suspended !== update.matchReason) {
        continue; // usage clear must not lift a different (admin) reason
      }
      delete entry.suspended;
    }
    await routing.put(key, JSON.stringify(entry));
  }
}

/**
 * Apply a {@link RoutingSuspensionUpdate} across a set of projects' routing
 * entries — each project's slug route plus EVERY `domain:<host>` route the
 * project has. This is the single source of truth for which KV keys carry a
 * project's suspension; dispatch enforces `routing.suspended` on all of them,
 * so suspending only the slug (the historical behaviour) left custom domains
 * serving past the cap, and unsuspending only the slug left them 429'd.
 *
 * We deliberately do NOT filter to `status === 'active'`. `tryActivateDomain`
 * writes the `domain:<host>` KV route BEFORE flipping the DB row to `active`
 * (self-healing ordering — see provisioning/activate-domain.ts), so a crash in
 * that window leaves a `pending` row whose KV route is already live and served
 * by dispatch. Filtering to active would skip that route and let a suspended
 * project keep serving on the hostname. Fanning out to every domain is safe:
 * {@link applyRoutingSuspension} skips any key with no KV entry, so a pending
 * domain that was never published is just a cheap no-op read.
 *
 * Batches the domain lookup over all projects. No-ops (no DB query) for an
 * empty project list.
 */
export async function setProjectsRoutingSuspension(
  routing: KVNamespace,
  db: Db,
  projects: ReadonlyArray<{ id: string; slug: string }>,
  update: RoutingSuspensionUpdate,
): Promise<void> {
  if (projects.length === 0) {
    return;
  }
  const domainMap = await getDomainsByProjectIds(
    db,
    projects.map((p) => p.id),
  );
  for (const project of projects) {
    const domainKeys = (domainMap.get(project.id) ?? []).map((d) => `domain:${d.hostname}`);
    // Serialize the fan-out with deploy/rollback publishers on the project
    // `FOR UPDATE` lock (the contract documented on `guardedRoutingKvRmw`): a
    // publisher holds the SAME lock while it writes the fresh route AND marks
    // `routing_published=true`. Running `applyRoutingSuspension`'s get→put UNDER
    // the lock means a publish that committed concurrently is RE-READ here, so
    // `suspended` is folded onto the FRESH route instead of a lock-free pre-publish
    // snapshot reverting the publish — a clobber the reconciler (which skips
    // `routing_published=true`) would never heal. Domains are looked up before the
    // lock; `applyRoutingSuspension` no-ops on any key without a live KV entry.
    await db.transaction(async (tx) => {
      await lockProjectAndGetActiveDeploymentId(tx as unknown as Db, project.id);
      await applyRoutingSuspension(routing, [project.slug, ...domainKeys], update);
    });
  }
}

export function buildRoutingJson(opts: {
  workerName: string;
  projectId: string;
  userId: string;
  manifest: DeployManifest | null;
  deploymentId: string;
  dispatchLimits: { cpuMs?: number; subRequests?: number } | null;
  suspended?: string;
  hasCrons?: boolean;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    workerName: opts.workerName,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? (manifest?.framework ? 'framework' : 'void'),
    ...(manifest?.ssr ? { ssr: true } : {}),
    ...(manifest?.revalidate ? { revalidate: manifest.revalidate } : {}),
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    version: opts.deploymentId,
    ...(opts.dispatchLimits ? { limits: opts.dispatchLimits } : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
    ...(opts.hasCrons ? { hasCrons: true } : {}),
    ...(opts.assetManifestId ? { assetManifestId: opts.assetManifestId } : {}),
    ...(opts.assetConfig ? { assetConfig: opts.assetConfig } : {}),
  });
}

export function buildStaticRoutingJson(opts: {
  projectId: string;
  userId: string;
  deploymentId: string;
  assetConfig: AssetConfig;
  manifest: DeployManifest | null;
  suspended?: string;
}): string {
  const { manifest } = opts;
  return JSON.stringify({
    staticDeploymentId: opts.deploymentId,
    projectId: opts.projectId,
    userId: opts.userId,
    type: manifest?.type ?? 'static',
    assetConfig: opts.assetConfig,
    version: opts.deploymentId,
    ...(manifest?.hashedAssetsPrefix ? { hashedAssetsPrefix: manifest.hashedAssetsPrefix } : {}),
    ...(manifest?.headerRules?.length ? { headerRules: manifest.headerRules } : {}),
    ...(manifest?.redirectRules?.length ? { redirectRules: manifest.redirectRules } : {}),
    ...(manifest?.fallbackRules?.length ? { fallbackRules: manifest.fallbackRules } : {}),
    ...(manifest?.revalidateQueryAllowlist
      ? { queryAllowlist: manifest.revalidateQueryAllowlist }
      : {}),
    ...(opts.suspended ? { suspended: opts.suspended } : {}),
  });
}
