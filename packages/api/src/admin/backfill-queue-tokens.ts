import { hmacSignState } from '../auth/hmac.ts';
import { type Db, lockProjectAndGetActiveDeploymentId } from '../db.ts';
import {
  getDispatchWorkerProxyToken,
  type ProxyTokenLookup,
} from '../provisioning/cloudflare-api.ts';

export type BackfillQueueTokensOptions = Readonly<{
  accountId: string;
  apiToken: string;
  dispatchNamespace: string;
  jwtSecret: string;
  /**
   * Override for tests. When set, replaces the live CF API call that
   * reads `__VOID_PROXY_TOKEN` from the target worker's bindings.
   */
  fetchToken?: (workerName: string) => Promise<ProxyTokenLookup>;
}>;

export type BackfillQueueTokensResult = Readonly<{
  scanned: number;
  updated: number;
  skipped: number;
  /**
   * Count of entries we skipped because a concurrent writer (deploy or
   * rollback) had modified the KV value between our initial read and
   * the final put. Operators can re-run the backfill to sweep these up
   * once the concurrent operation completes.
   */
  raced: number;
  /**
   * Count of entries we skipped because the CF bindings read threw a
   * transient/error response (rate limit, network, 5xx). Operators can
   * re-run the backfill once the underlying CF issue resolves.
   * Intentionally separated from `skipped` so a transient incident
   * cannot masquerade as a successful migration.
   */
  errored: number;
  /**
   * Count of legacy entries we skipped because they carry no `projectId`,
   * so there is no project row to lock and serialize against concurrent
   * deploy/rollback publishers. A lock-free re-read-then-put on such an
   * entry has a TOCTOU window that could clobber a concurrently-published
   * active worker route — permanently, since the newer active deployment is
   * already `routing_published=true` and the reconciler heals only
   * unpublished rows. We do NOT write these (the safe minimal fix); robustly
   * backfilling legacy entries is a separate follow-up. Surfaced (not folded
   * into `skipped`) so operators can see the legacy backlog explicitly.
   */
  skippedLegacy: number;
}>;

type QueueRoutingEntry = Readonly<{
  workerName?: string;
  projectId?: string;
  queueName?: string;
  proxyToken?: string;
  [key: string]: unknown;
}>;

/**
 * Iterate every `queue:*` KV entry and stamp `proxyToken` on any entry
 * written before the dispatch relay started forwarding
 * `x-void-internal`. The stamped token is read from the target worker's
 * `__VOID_PROXY_TOKEN` binding so it survives `JWT_SECRET` rotation —
 * a freshly `hmacSignState(projectId, currentSecret)` value would 401
 * any worker deployed before the rotation.
 *
 * Concurrency-safe: entries carrying a `projectId` take the project FOR
 * UPDATE lock, RE-READ the entry under the lock, and put ONLY if it is still
 * byte-identical to the pre-fetch snapshot — so a concurrent deploy/rollback
 * publish that lands after the snapshot serializes behind this RMW and is NOT
 * clobbered (a lock-free re-read-then-put has a TOCTOU window between the
 * equality check and the put; the clobbered route would then be permanently
 * stuck because the newer active deployment is already `routing_published=true`
 * and the reconciler heals only unpublished rows). Entries WITHOUT a
 * `projectId` have no lockable project, so there is no way to serialize against
 * a concurrent publisher: a lock-free re-read-then-put could still clobber a
 * freshly-published active worker route (permanently — the newer active
 * deployment is `routing_published=true` and the reconciler heals only
 * unpublished rows). We therefore SKIP those legacy entries entirely rather than
 * risk the clobber, report them in `skippedLegacy`, and log a running count.
 * Backfilling them robustly is a separate follow-up (`getProjectQueueName` is
 * lossy, so the projectId cannot be reversed from the key).
 */
export async function backfillQueueTokens(
  routing: KVNamespace,
  db: Db,
  opts: BackfillQueueTokensOptions,
): Promise<BackfillQueueTokensResult> {
  const fetchToken =
    opts.fetchToken ??
    ((workerName: string) =>
      getDispatchWorkerProxyToken(
        opts.accountId,
        opts.apiToken,
        opts.dispatchNamespace,
        workerName,
      ));

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let raced = 0;
  let errored = 0;
  let skippedLegacy = 0;

  let cursor: string | undefined;
  do {
    const page = await routing.list({ prefix: 'queue:', ...(cursor ? { cursor } : {}) });
    for (const { name } of page.keys) {
      scanned++;
      const snapshotRaw = await routing.get(name);
      if (!snapshotRaw) {
        skipped++;
        continue;
      }
      let entry: QueueRoutingEntry;
      try {
        entry = JSON.parse(snapshotRaw) as QueueRoutingEntry;
      } catch {
        skipped++;
        continue;
      }
      if (entry.proxyToken) {
        skipped++;
        continue;
      }
      if (!entry.workerName) {
        // Without a workerName there is no way to fetch the baked token
        // and no deploymentId to re-derive meaningfully. Leave alone.
        skipped++;
        continue;
      }

      const lookup = await fetchToken(entry.workerName);
      let proxyToken: string;
      if (lookup.kind === 'found') {
        proxyToken = lookup.token;
      } else if (lookup.kind === 'error') {
        // Transient CF failure. Do NOT silently fall back — that would
        // stamp a potentially wrong token, report the row as `updated`,
        // and permanently mask a control-plane incident as migrated.
        console.error(
          `[backfill-queue-tokens] CF API error reading bindings for "${entry.workerName}": ${lookup.error.message}. Skipping "${name}" — rerun when CF is healthy.`,
        );
        errored++;
        continue;
      } else if (entry.projectId) {
        // lookup.kind === 'missing' — legacy worker, no baked binding.
        // Fall back to re-derivation. Only safe while JWT_SECRET has
        // not rotated since this worker was deployed.
        proxyToken = await hmacSignState(entry.projectId, opts.jwtSecret);
      } else {
        skipped++;
        continue;
      }

      const nextRaw = JSON.stringify({ ...entry, proxyToken });

      if (entry.projectId) {
        // Lock-guarded RMW: take the project FOR UPDATE lock the deploy/
        // rollback/reconciler publishers take, RE-READ under the lock, and put
        // ONLY if still byte-identical to the snapshot. A concurrent publish
        // either committed before this lock (re-read no longer matches → skip,
        // its route survives) or serializes behind this RMW. Closes the TOCTOU
        // window a lock-free re-read-then-put leaves between the equality check
        // and the put.
        const projectId = entry.projectId;
        const didPut = await db.transaction(async (tx): Promise<boolean> => {
          await lockProjectAndGetActiveDeploymentId(tx as unknown as Db, projectId);
          const currentRaw = await routing.get(name);
          if (currentRaw !== snapshotRaw) {
            return false;
          }
          await routing.put(name, nextRaw);
          return true;
        });
        if (didPut) {
          updated++;
        } else {
          raced++;
        }
        continue;
      }

      // No projectId ⇒ no lockable project. There is no way to serialize this
      // put against a concurrent deploy/rollback publisher (the lock is keyed by
      // project), so a lock-free re-read-then-put could clobber a freshly-
      // published active worker route — permanently, since the newer active
      // deployment is already `routing_published=true` and the reconciler heals
      // only unpublished rows. SKIP the write rather than risk the clobber.
      // Report it in `skippedLegacy` (not `skipped`) and log a running count so
      // the legacy backlog is visible and never silently capped.
      skippedLegacy++;
      console.warn(
        `[backfill-queue-tokens] SKIPPED legacy queue entry "${name}" with no projectId (cannot lock to serialize against publishers; skippedLegacy=${skippedLegacy}). Robust legacy backfill is a follow-up.`,
      );
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { scanned, updated, skipped, raced, errored, skippedLegacy };
}
