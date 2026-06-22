import { DurableObject } from 'cloudflare:workers';
import type { BuildManager } from './build-manager.ts';
import { type BuildConfig, isContainerCapacityError } from './build-types.ts';
import {
  claimBuildForStartWithinLimit,
  createDb,
  getGitHubConnection,
  getProject,
  getQueuedBuilds,
  getUser,
  getUsersWithQueuedContainerBuilds,
  hasQueuedContainerBuilds,
  markBuildTerminalIfActive,
  requeueBuildIfStarting,
  updateBuildStatus,
} from './db.ts';
import type { ApiEnv } from './env.ts';
import { getBuildInstanceType, getPlanLimits } from './tiers.ts';

/** A poke arms the alarm this far ahead so the next scan runs almost immediately. */
const POKE_DELAY_MS = 50;

/** While the queue still has work the alarm reschedules this far ahead. */
const RESCAN_DELAY_MS = 2_000;

/** When the container fleet is at capacity, back off this long (jittered) before
 *  re-scanning instead of the normal 2s cadence — avoids burning GitHub/token calls
 *  every tick while builds are stalled. A completion poke re-arms sooner. */
const CAPACITY_BACKOFF_BASE_MS = 20_000;
const CAPACITY_BACKOFF_JITTER_MS = 10_000;

/** Cap on builds inspected per alarm scan (mirrors `getQueuedBuilds` default). */
const SCAN_LIMIT = 50;

/**
 * Singleton DO (`idFromName('global')`) that drains the `executor='container'`
 * build queue. A webhook `POST /poke` arms a near-immediate alarm; the alarm
 * pulls queued builds FIFO, enforces per-user tier concurrency, atomically
 * claims each startable build, and hands it to a per-build BuildManager over
 * DO→DO RPC. The alarm reschedules itself only while the queue is non-empty —
 * an empty queue lets the alarm go quiet until the next poke, exactly like
 * `CronScheduler` lets its alarm lapse when there are no schedules.
 */
export class BuildScheduler extends DurableObject<ApiEnv['Bindings']> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/poke') {
      // Arm a near-immediate alarm relative to the current clock (same
      // clock+offset pattern CronScheduler uses for setAlarm). Idempotent:
      // overwriting an already-armed alarm just keeps the earliest scan.
      await this.ctx.storage.setAlarm(Date.now() + POKE_DELAY_MS);
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && path === '/status') {
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({ nextAlarm: alarm });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const db = createDb(this.env.HYPERDRIVE.connectionString);

    // Compute which queue owners are AT their plan's concurrency cap and exclude
    // them from the scan. The cap is plan-derived (`getPlanLimits`), not a DB
    // column, so it can't be filtered in SQL — without this, a capped tenant's
    // lowest-project_id rows would fill the scan limit every tick and the claim
    // step would reject them all, indefinitely delaying an unrelated under-cap
    // tenant. `limit === 0` means unlimited (never capped). `hasQueuedContainer-
    // Builds` below still reflects ANY queued work, so the alarm keeps re-arming
    // while an excluded owner's work waits — it becomes claimable the moment they
    // free a slot.
    const owners = await getUsersWithQueuedContainerBuilds(db);
    const cappedUserIds = owners
      .filter((o) => {
        const limit = getPlanLimits(o.plan).concurrentBuilds;
        return limit > 0 && o.activeBuilds >= limit;
      })
      .map((o) => o.userId);

    const queued = await getQueuedBuilds(db, SCAN_LIMIT, cappedUserIds);
    if (queued.length === 0) {
      // No STARTABLE builds this tick. getQueuedBuilds excludes builds whose project
      // already has an active build, so a queue that is fully blocked returns [] here
      // even though queued work remains. Keep the heartbeat armed (rather than relying
      // solely on a completion poke, which can be missed) so the blocked build is
      // retried as soon as its project frees. A genuinely empty queue lets the alarm
      // lapse; a subsequent `/poke` re-arms it.
      if (await hasQueuedContainerBuilds(db)) {
        await this.ctx.storage.setAlarm(Date.now() + RESCAN_DELAY_MS);
      }
      return;
    }

    // Set when a container-capacity error sheds the scan early (see the capacity
    // branch below). Drives the longer, jittered re-arm so we don't hot-loop
    // GitHub/token calls every 2s while the fleet is full.
    let capacityShed = false;
    for (const build of queued) {
      const user = await getUser(db, build.user_id);
      if (!user) {
        // Orphaned build with no owning user — can't attribute concurrency or
        // mint a token. Fail it so it leaves the queue and never blocks.
        await updateBuildStatus(db, build.id, 'failed', {
          error: 'owning user not found',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      // Resolve the connection + project BEFORE claiming. A claim flips the row
      // queued->starting (it becomes "active"), but the per-build BuildManager —
      // which owns the wall-clock timeout — is only created later, inside the
      // try/catch around startBuild. If a lookup here THREW after the claim, the
      // alarm would abort with the row stuck `starting` forever: there is no
      // BuildManager to time it out, and the scheduled stale reaper only covers
      // github_actions builds. Doing the lookups first means a transient DB error
      // leaves the build `queued` (retried next tick) and a genuinely missing
      // connection/project marks it failed while it is still terminalizable.
      const connection = await getGitHubConnection(db, build.project_id);
      if (!connection) {
        // A container build can't run without a github connection (no repo to
        // fetch, no installation token). Mark failed and move on.
        await updateBuildStatus(db, build.id, 'failed', {
          error: 'no github connection for project',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      // Defense-in-depth: refuse to START a queued build whose stored
      // branch/executor no longer matches the current connection. The enqueue
      // path is serialized on the github_connections row so it won't insert a
      // build for a stale config, but a build that was already queued before the
      // connection flipped (branch retarget, or executor switched to
      // github_actions) must not run here — the JIT freshness check in
      // BuildManager is branch-HEAD-only and does NOT catch a branch/executor
      // mismatch. A config change is not a build failure, so mark it `cancelled`.
      // Guard `build.branch != null` so a null-branch legacy row is left alone.
      if (
        build.branch != null &&
        (build.branch !== connection.branch || build.executor !== connection.build_executor)
      ) {
        await updateBuildStatus(db, build.id, 'cancelled', {
          error: 'github connection config changed',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      const project = await getProject(db, build.project_id);
      if (!project) {
        await updateBuildStatus(db, build.id, 'failed', {
          error: 'project not found',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      // Atomically enforce the per-user cap AND claim queued->starting in a
      // SINGLE transaction holding `SELECT ... FOR UPDATE` on the owner's users
      // row — the SAME lock the OIDC path (`createGithubActionsBuildWithinLimit`)
      // takes. This makes the container-scheduler path and the OIDC path
      // mutually exclusive per user, so a scheduler scan and a parallel OIDC
      // exchange can't both observe sub-cap capacity and both create active
      // builds (which the old separate count-then-claim allowed). `limit === 0`
      // means unlimited. Returns false when at cap OR when the build was already
      // claimed elsewhere; either way leave it for a later tick. This is the
      // commit point: only pure config assembly + the try/catch-wrapped
      // startBuild follow it, so nothing can throw between the claim and the
      // BuildManager that owns the timeout.
      const limit = getPlanLimits(user.plan).concurrentBuilds;
      const claimed = await claimBuildForStartWithinLimit(db, {
        buildId: build.id,
        userId: build.user_id,
        projectId: build.project_id,
        limit,
      });
      if (!claimed) {
        continue;
      }

      const config: BuildConfig = {
        buildId: build.id,
        projectId: build.project_id,
        projectSlug: project.slug,
        userId: build.user_id,
        login: user.login,
        commitSha: build.commit_sha ?? '',
        branch: build.branch ?? connection.branch,
        repoFullName: connection.repo_full_name,
        installationId: connection.installation_id,
        // The build row carries no repository id, so the connection bound to this
        // project (resolved above by the UNIQUE project_id) is the source of
        // truth — mirrors webhooks.ts / auth-oidc.ts. startBuild re-verifies the
        // App installation still covers this repo before minting the deploy
        // token; a null id fails that check closed.
        repositoryId: connection.repository_id,
        instanceType: getBuildInstanceType(user.plan),
        timeoutMinutes: getPlanLimits(user.plan).buildTimeoutMinutes,
      };

      const stub = this.env.BUILD_MANAGER.get(
        this.env.BUILD_MANAGER.idFromName(build.id),
      ) as unknown as DurableObjectStub<BuildManager>;
      try {
        await stub.startBuild(config);
      } catch (error) {
        if (isContainerCapacityError(error)) {
          // Global BuildManager fleet (max_instances) is full — transient platform
          // pressure, not a build failure. Return the row to `queued` so the next
          // alarm retries it once an instance frees; the heartbeat keeps the alarm
          // armed while queued work remains. Guarded (starting -> queued only): if a
          // concurrent terminalizer (push-supersede, branch/executor change,
          // disconnect, install removal) already drove this claimed row terminal
          // while startBuild was in flight, this no-ops and the terminal status is
          // preserved — a superseded/cancelled commit can't be resurrected here.
          await requeueBuildIfStarting(db, build.id);
          // Stop scanning the rest of the batch. startBuild does the GitHub
          // branch-head compare + installation-token mint BEFORE the container
          // start() throws capacity, so continuing to drain at fleet capacity would
          // burn up to SCAN_LIMIT GitHub/token calls every tick on builds that will
          // all hit the same full fleet. Only THIS build was claimed (queued ->
          // starting) — the rest of the batch was never claimed, and builds already
          // started earlier this tick are genuine successes, so they are left as-is.
          // The longer jittered re-arm below backs off until a slot frees (a
          // completion poke re-arms sooner).
          capacityShed = true;
          break;
        }
        // Defense-in-depth: a throw here must not abort the rest of the scan.
        // BuildManager.startBuild already fails the row + frees the slot on a
        // pre-alarm error, but a transport-level RPC failure (the manager never
        // reaches its own catch) would otherwise leave the row stuck `starting`
        // and permanently consume a concurrency slot. Mark it failed so the slot
        // frees, then keep draining the queue.
        //
        // CAS terminal-if-active (NOT an unconditional write): a concurrent cancel
        // (terminateBuildsForProject commits 'cancelled' out-of-band, then the
        // cancelBuild RPC) can have already driven this claimed row terminal while
        // startBuild was in flight. An unconditional updateBuildStatus('failed')
        // would clobber that 'cancelled' to 'failed'; the CAS no-ops on an
        // already-terminal row (the slot is already freed).
        //
        // Best-effort: a transient Hyperdrive/Postgres error on THIS write must
        // not abort `alarm()` before the tail reschedule below. Without the
        // try/catch the throw escapes the loop AND skips the re-arm, so the global
        // scheduler goes quiet while this row stays `starting` (slot held) until an
        // unrelated poke or the stale reaper. Swallow + log instead: the row is
        // reaped, and the heartbeat below stays armed so the rest of the queue
        // keeps draining. Mirrors BuildManager's finally-poke invariant for its own
        // terminal write.
        const message = error instanceof Error ? error.message : String(error);
        try {
          await markBuildTerminalIfActive(db, build.id, 'failed', {
            error: `failed to start build: ${message}`,
            completedAt: new Date().toISOString(),
          });
        } catch (writeError) {
          console.error(
            `[build-scheduler] failed to mark build ${build.id} failed after a startBuild RPC error; continuing the scan so the queue heartbeat stays armed`,
            writeError,
          );
        }
      }
    }

    // Reschedule while ANY queued container build remains — not just startable
    // ones. `getQueuedBuilds` now surfaces only builds whose project is idle, so
    // a queue that is fully blocked (every project has an active build) returns
    // []; if we keyed the heartbeat off that, blocked builds would resume only
    // on a completion poke and a missed poke would strand them. `hasQueued*`
    // keeps the alarm armed until the queue is genuinely empty, so a freed
    // project is always picked up on the next tick. Compute the wake time from
    // the current clock + offset, exactly like CronScheduler.
    if (await hasQueuedContainerBuilds(db)) {
      // When the scan was shed because the fleet is at capacity, back off with a
      // jittered delay instead of the normal 2s cadence — otherwise we'd re-run
      // the GitHub compare + token mint every 2s for builds that will keep
      // hitting the full fleet. The backoff is only the missed-poke backstop:
      // BuildManager.onStop / timeout / cancelBuild all pokeScheduler() (a ~50ms
      // alarm), and setAlarm overwrites the pending backoff to the earliest armed
      // time, so a freed slot pulls the next scan in immediately.
      const delay = capacityShed
        ? CAPACITY_BACKOFF_BASE_MS + Math.floor(Math.random() * CAPACITY_BACKOFF_JITTER_MS)
        : RESCAN_DELAY_MS;
      await this.ctx.storage.setAlarm(Date.now() + delay);
    }
  }
}
