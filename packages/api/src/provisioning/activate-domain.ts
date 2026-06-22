import {
  activateDomainIfPending,
  type Db,
  lockProjectForPublish,
  updateDomainVerificationData,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import type { DomainVerificationData } from '../schema.ts';
import type { Domain, Project } from '../types.ts';
import {
  type CustomHostnameInfo,
  getCustomHostname,
  patchCustomHostname,
} from './cloudflare-api.ts';

export type ActivateDomainResult = Readonly<{
  cf: CustomHostnameInfo;
  gateOk: boolean;
  activated: boolean; // true iff THIS call wrote KV + flipped status -> active
  awaitingDeployment: boolean; // gate passed but project has no slug routing yet
}>;

// Polls CF, evaluates the activation gate, and — when satisfied and the project
// has live slug routing — copies the slug routing entry to `domain:<host>` in KV
// and flips the DB row to active. Also refreshes verification_data. Mutates the
// passed `domain` object's `status`/`verification_data` in place so a caller can
// spread it directly. Shared by the status route and the reconciliation cron so
// the security gate has ONE definition. Note: when `wasPending` is false (domain
// already active), `slugRouting` is not fetched and `awaitingDeployment` is
// therefore always false — callers should pass pending rows.
//
// `options.retriggerDcv` gates the best-effort HTTP-DCV re-trigger PATCH (see the
// PATCH block below). It defaults to OFF: the status route and the janitor never
// PATCH. Only the HOURLY reconcile tier passes `true`, which bounds the
// per-account CF custom-hostname API load — a burst of young pending domains on
// the every-2-min fast tier would otherwise fire ~N PATCH/2min and risk 429ing
// other tenants' hostname operations, while CF's own sub-minute early retries
// already cover that window. The PATCH's real value (re-triggering the long tail
// + resetting CF's decaying 7-day backoff) is fully served by the hourly cadence.
export async function tryActivateDomain(
  env: ApiEnv['Bindings'],
  db: Db,
  domain: Domain,
  project: Project,
  options?: { retriggerDcv?: boolean },
): Promise<ActivateDomainResult> {
  // Capture original pending status before any mutation so awaitingDeployment
  // is computed against the pre-mutation state.
  const wasPending = domain.status === 'pending';

  // Poll CF API for live status
  const cf = await getCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);

  // Custom-hostname validation has two independent axes:
  //   - Hostname OWNERSHIP — proven by the `_cf-custom-hostname` TXT, surfaced
  //     as `ownership_verification`, and the input to the top-level `status`.
  //   - Certificate DCV — `ssl.method` / `ssl.validation_records`, the input
  //     to `ssl.status`.
  // The anti-wildcard-hijack lever is the OWNERSHIP gate, NOT the cert-DCV
  // method: a wildcard CNAME (`*.victim → cname.void.app`) cannot forge a
  // per-host `_cf-custom-hostname` TXT value, so ownership stays unsatisfied
  // and `status` never reaches `active`. Cert DCV (now HTTP-based, edge-
  // validated, auto-renewing) is orthogonal and method-agnostic here, which
  // is also what keeps legacy `txt`-method pending domains activatable with
  // no migration.
  //
  // The primary signal is CF's own `status === 'active'`: for a hostname
  // proxying through CF (which a custom domain always is), CF only flips
  // `status` to `active` after DNS-based ownership completes. The absence of
  // BOTH outstanding ownership challenges — the TXT `ownership_verification`
  // AND the HTTP `ownership_verification_http` — is defense-in-depth on top
  // of that (CF stops returning them once ownership is proven), so we refuse
  // to route even if CF ever surfaced `active` with an ownership challenge
  // still outstanding. We deliberately do NOT add our own DNS re-check here:
  // it would break a domain whenever a user removed the TXT after setup, for
  // no real gain over CF's gate. The foundational assumption (CF won't go
  // `active` without DNS ownership for a proxying hostname) is validated by
  // the staging spike (plan Phase 0) before this ships.
  const gateOk =
    cf.status === 'active' &&
    cf.ssl.status === 'active' &&
    !cf.ownership_verification &&
    !cf.ownership_verification_http;

  // Only activate after KV routing is in place. If the project has never
  // been deployed, `project.slug` is absent from KV; leaving the DB row in
  // 'pending' ensures the next poll retries (a future deploy populates the
  // slug entry).
  // Self-healing ordering: the DB flip is a CONDITIONAL claim
  // (`activateDomainIfPending`) issued inside the activation tx, with the KV
  // write awaited BEFORE the tx commits. Durable effects therefore order as
  // KV-put-then-DB-commit, so a crash between them rolls the (uncommitted) claim
  // back, leaves the row `pending`, and the next poll/cron retries and re-writes
  // the same KV entry — the system heals itself, exactly as the old KV-first
  // ordering did. See the in-tx comment for the full failure-window analysis.
  // Resurrection of a deleted row is now CLOSED (was design-doc 0073's accepted
  // limitation, then narrowed by the under-lock re-read, now eliminated): a
  // concurrent `void domain delete` / the stale-pending janitor and this
  // activation BOTH gate on `status='pending'` at the ROW level (the delete is
  // `deleteDomainIfPending`, the activation is the conditional claim below), so
  // under READ COMMITTED whichever commits first wins and the other matches 0
  // rows. The KV `domain:<host>` is written ONLY after a successful claim, so a
  // deleted row can never have a route (re)created.
  // Stale-snapshot race: the slug ROUTING entry is the CURRENT active
  // deployment's route, but a lock-free read can be clobbered by a concurrent
  // deploy/rollback. If we read deployment A's slug route, then deployment B
  // goes live (flips `active_deployment_id`, publishes its routing, and marks
  // `routing_published=true`), and only THEN we copy A's stale route into
  // `domain:<host>` and flip the row active — the live-routing reconciler will
  // never repair it (its query selects only active deployments NOT yet marked
  // `routing_published`, and B is already marked), so the domain serves A's
  // stale route until the next deploy/rollback.
  //
  // Close it by serializing the slug-read → domain-write on the SAME project
  // `FOR UPDATE` lock the deploy/rollback go-live tx and the reconciler take
  // (via `publishRoutingIfStillActive`). Holding the lock across the re-read +
  // domain write guarantees one of two safe orderings against a racing
  // publisher B:
  //   - B published + marked BEFORE we took the lock → we re-read B's CURRENT
  //     slug route and write THAT (not a pre-lock snapshot).
  //   - B is blocked behind our lock → it has not marked yet; after we release,
  //     B's publish runs and heals every active `domain:<host>` (it iterates
  //     active domains — and we marked this one active under the lock) with B's
  //     route.
  // Either way the domain key ends up consistent with the active deployment.
  // We need only the slug route to be FROZEN for the read+write, not a
  // deployment-id match, so we take the lock directly (via
  // `lockProjectForPublish`, reading `status` but not asserting a specific id)
  // rather than through `publishRoutingIfStillActive`, which gates on a specific
  // id.
  //
  // Read the slug entry whenever the CF gate is satisfied so we can surface
  // `awaitingDeployment` to the caller regardless of whether activation
  // actually happened (activation also requires `domain.status === 'pending'`).
  // This lock-free read is for `awaitingDeployment` only; the authoritative
  // value that gets copied into the domain key is RE-READ under the lock below.
  const slugRouting = gateOk && wasPending ? await env.ROUTING.get(project.slug) : null;

  let activated = false;
  if (gateOk && wasPending && slugRouting) {
    // Re-read the active deployment's slug route under the project lock and
    // write the domain key from THAT, so the route we copy belongs to whatever
    // deployment is active RIGHT NOW. The deploy/rollback go-live tx and the
    // reconciler take the SAME `SELECT ... FOR UPDATE` lock and publish slug KV
    // only while holding it (see `publishRoutingIfStillActive`), so holding it
    // here freezes both the active pointer AND the slug route across our
    // re-read + domain write. If the active deployment's slug route is gone by
    // the time we hold the lock (the active deployment was unpublished), we
    // write NOTHING and leave the row `pending` so the next poll/cron retries —
    // never a stale/empty domain route. KV-put-then-DB-commit self-healing
    // ordering is preserved (the KV put is awaited before the tx commits).
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Acquire the project FOR UPDATE lock AND re-read `status` under it. Its
      // purpose here is to FREEZE the slug route against concurrent publishers
      // (which hold the same lock while writing slug KV), not to assert a
      // specific pointer value — we ignore the returned id; the slug KV presence
      // is itself the "a deployment is live" signal. It does NOT serialize
      // against the stale-pending janitor — `cleanupStalePendingDomains` deletes
      // pending rows WITHOUT taking this lock — so the row-level conditional
      // claim below is what excludes it.
      //
      // The `project` arg is a STALE pre-lock snapshot from the caller, never
      // re-read under the lock — so we re-read `status` here. `teardownProject`
      // flips `status='deleting'` and COMMITS, THEN deletes `domain:<host>` +
      // slug KV lock-free, THEN cascade-deletes the rows LAST. A pending-domain
      // verification that interleaves during teardown would otherwise take the
      // lock, find the row still `pending`, and re-PUT `domain:<host>` for a
      // project about to vanish → an orphan route the reconciler can never heal
      // (the project row is gone). Bail on a deleting/missing project, writing
      // NOTHING — mirroring `publishRoutingIfStillActive`'s same-lock guard.
      const locked = await lockProjectForPublish(txDb, project.id);
      if (locked === null || locked.status === 'deleting') {
        return;
      }
      // Read the active deployment's slug route under the lock. If it is gone
      // (the active deployment was unpublished), write NOTHING and leave the row
      // `pending` so the next poll/cron retries — never a stale/empty route.
      const current = await env.ROUTING.get(project.slug);
      if (!current) {
        return;
      }
      // CLAIM-then-WRITE. Flip the row to `active` with a SINGLE atomic
      // conditional UPDATE (`... WHERE id AND project_id AND status='pending'
      // RETURNING`). This mutually excludes the janitor's conditional delete
      // (`DELETE ... WHERE id AND status='pending'` in `cleanupStalePendingDomains`,
      // which takes NO project lock) at the ROW level under READ COMMITTED:
      // whichever statement commits first wins and the other matches 0 rows. So
      //   - if the janitor's delete commits first, this claim matches 0 rows →
      //     we write NO KV and resurrect nothing;
      //   - if this claim commits first, the janitor's delete matches 0 rows →
      //     it skips teardown and leaves the now-live domain alone.
      // The claim also subsumes the old read-then-write pre-check (a `getDomain`
      // re-read followed by an unconditional `updateDomainStatus`): a `false`
      // result covers BOTH "row deleted by the janitor" AND "already activated by
      // a racing poll", and — being a single atomic statement — it has NO
      // read↔write window for a delete to slip through (the old pre-check did:
      // the janitor's delete could commit AFTER the `getDomain` read but BEFORE
      // the unconditional flip, leaving the flip matching 0 rows while the KV was
      // already written → an orphan route — F30).
      //
      // Ordering of DURABLE effects is KV-put-then-DB-commit, preserving the
      // original self-healing property:
      //   - The conditional claim is issued INSIDE this tx (uncommitted until the
      //     callback resolves). The KV `env.ROUTING.put` is the next awaited step,
      //     and DB commit happens only AFTER it resolves.
      //   - A crash/abort BETWEEN the put and the commit rolls the claim back
      //     (uncommitted) → the row stays `pending`, so the next poll/cron
      //     re-runs activation and re-writes the same KV. The transient KV entry
      //     already points to THIS project's own slug route, so it is correct,
      //     not an orphan.
      //   - A `put` THROW rejects the callback → the whole tx rolls back, undoing
      //     the claim → row back to `pending`, no half-applied state.
      // The KV is written only AFTER a successful claim, so a row the janitor
      // already deleted (claim `false`) can never have a route (re)created.
      const claimed = await activateDomainIfPending(txDb, domain.id, project.id);
      if (!claimed) {
        return;
      }
      await env.ROUTING.put(`domain:${domain.hostname}`, current);
      activated = true;
      domain.status = 'active';
    });
  }

  const awaitingDeployment = gateOk && wasPending && !slugRouting;

  if (cf.ownership_verification || cf.ssl.validation_records) {
    const verificationData: DomainVerificationData = {
      ownership_verification: cf.ownership_verification,
      ssl_validation_records: cf.ssl.validation_records,
    };
    await updateDomainVerificationData(db, domain.id, verificationData);
    domain.verification_data = verificationData;
  }

  // Best-effort re-trigger of HTTP DCV for an add-first domain that hasn't yet
  // validated. Void creates the CF hostname with `ssl.method:'http'` before the
  // user points the CNAME at `cname.void.app`; per CF's Create Custom Hostname
  // API docs the PATCH method must be used once the domain is pointing at the
  // Managed CNAME for HTTP validation to complete. A no-change PATCH re-sends
  // the `ssl` block, re-triggering DCV AND resetting CF's decaying validation
  // backoff so a user who fixes DNS doesn't wait out the slowing retry schedule
  // (and avoids CF's 7-day delete). Gated on:
  //   - `options.retriggerDcv` — only the hourly reconcile tier opts in, to
  //     bound CF custom-hostname API load (see the function-level comment).
  //   - `wasPending && !gateOk` — skip if already gated (validated) or active.
  //   - `cf.ssl.method === 'http'` — only re-trigger HTTP-DCV hostnames. A
  //     LEGACY pending hostname still on `txt` (created under the old TXT-DCV
  //     flow, user still publishing `_acme-challenge` records) must keep its
  //     existing method — switching it to HTTP-DCV would discard the user's
  //     in-progress validation and break the no-migration guarantee.
  // Fully isolated — a PATCH failure must never throw or affect the result.
  if (options?.retriggerDcv && wasPending && !gateOk && cf.ssl.method === 'http') {
    await patchCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id).catch(
      (err) =>
        console.error(
          `[activate-domain] failed to re-trigger HTTP DCV for ${domain.hostname}:`,
          err,
        ),
    );
  }

  return { cf, gateOk, activated, awaitingDeployment };
}
