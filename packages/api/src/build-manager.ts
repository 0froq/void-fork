import { Container } from '@cloudflare/containers';
import {
  DEPLOY_TOKEN_HARD_MAX_MINUTES,
  deployTokenTtlSecondsForBuildMinutes,
  signDeployToken,
} from './auth/deploy-token.ts';
import { type BuildConfig, type BuildLogLine, isContainerCapacityError } from './build-types.ts';
import { SITE_DOMAIN } from './constants.ts';
import {
  createDb,
  getBuild,
  getDeploymentByProjectAndCommit,
  installationCoversRepo,
  markBuildBuildingIfStarting,
  markBuildProgressIfActive,
  markBuildTerminalIfActive,
  requeueBuildIfStarting,
  setBuildCheckRunId,
  type Db,
} from './db.ts';
import type { ApiEnv } from './env.ts';
import { type CheckRunConclusion, completeCheckRun, createCheckRun } from './github/check-run.ts';
import {
  generateSourceTarballUrl,
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from './github/installation-token.ts';

/** DO storage keys for the build config captured at `startBuild()`. */
const STORAGE_KEY_CONFIG = 'buildConfig';
/** DO storage key for the per-build agent secret minted at `startBuild()`. */
const STORAGE_KEY_AGENT_TOKEN = 'agentToken';
/** DO storage key for the GitHub Check Run id created at `startBuild()`. */
const STORAGE_KEY_CHECK_RUN = 'checkRunId';

/** Build statuses past which no further transition should occur. */
const TERMINAL_STATUSES: ReadonlyArray<StoredBuildStatus> = ['complete', 'failed', 'cancelled'];

// Hard cap on rows retained in the DO SQLite `logs` table. A verbose/chatty build
// (huge installer/compiler output) would otherwise grow the table without bound
// for the build's lifetime — risking DO storage pressure and an O(rows) WebSocket
// replay on connect. `handleLogs` evicts the oldest rows past this cap, keeping
// the most-recent window (a tail is what a live log view wants). Mirrors the
// container agent's in-memory ring bound (build-agent.mjs MAX_BUFFERED_LOG_LINES).
export const MAX_STORED_LOG_LINES = 10000;

// Pin the build container's fallback Void CLI to the platform's shipped version.
// Keep in sync with framework/packages/void/package.json (the submodule the
// platform deploys against). Prevents a moving `void@latest` from changing
// deploy behavior with no repo diff.
const PINNED_VOID_CLI_VERSION = '0.9.1';

// Ceiling on how long a queued build may wait for the just-in-time branch-head
// freshness recheck to succeed. While the GitHub compare API is unreachable
// (returns null) we requeue and retry on the next alarm; but no container is
// started on that path, so nothing would ever reap a persistently-null build —
// past this age we fail it rather than loop forever.
const FRESHNESS_VERIFY_MAX_AGE_MS = 30 * 60 * 1000;

// Idle safety-net for a stuck/orphaned container, expressed as the build's
// wall-clock hard max plus a margin so it can never cut a legitimately busy
// build short. `sleepAfter` is an IDLE timeout (not a wall-clock cap) and nothing
// renews it after start — the per-build wall-clock cap is `enforceTimeout`. Kept
// in lockstep with `DEPLOY_TOKEN_HARD_MAX_MINUTES` so the idle net always sits
// above the longest a build can legitimately run. The +15m margin matches the
// STALE reaper margin.
const SLEEP_AFTER_MINUTES = DEPLOY_TOKEN_HARD_MAX_MINUTES + 15;

/**
 * Constant-time string compare to avoid leaking the agent secret via response
 * timing. Length is compared up front (lengths aren't secret here), then every
 * byte is XORed so the loop runs the full length regardless of mismatch
 * position.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

type StoredBuildStatus =
  | 'queued'
  | 'starting'
  | 'building'
  | 'deploying'
  | 'complete'
  | 'failed'
  | 'cancelled';

/** Stored build config plus the live status we track inside the DO. */
type ManagerState = BuildConfig & { status: StoredBuildStatus };

/**
 * Per-build DO (keyed by build id) that runs one build inside a Cloudflare
 * Container, streams the container's logs to attached WebSocket consumers,
 * enforces a wall-clock timeout, and writes every status transition back to
 * Postgres via Hyperdrive.
 *
 * The container runs the real `void deploy` CLI (see PR 8's build agent) with a
 * short-lived project-scoped `VOID_TOKEN`, so the platform's deploy endpoint is
 * unchanged. This DO never dispatches to user workers — DO→container,
 * DO→Hyperdrive, and DO→`api.github.com` are all allowed here.
 */
export class BuildManager extends Container<ApiEnv['Bindings']> {
  // Container config — the agent listens on 4000 and needs egress (tarball
  // download, npm install, deploy upload). `sleepAfter` is an IDLE timeout (a
  // safety-net that stops a stuck/orphaned container with no activity), NOT a
  // wall-clock cap and NOT renewed after start. The per-build wall-clock cap is
  // `enforceTimeout` (armed in startBuild). sleepAfter is sized above the hard
  // max (see SLEEP_AFTER_MINUTES) so it can never stop a legitimately running
  // build before enforceTimeout fires.
  override defaultPort = 4000;
  override enableInternet = true;
  override sleepAfter = `${SLEEP_AFTER_MINUTES}m`;

  // In-memory fallback for the just-created check-run id, set in startBuild right
  // after createCheckRun. The durable sources are DO storage + `builds.check_run_id`,
  // but if BOTH best-effort persists fail the id lives only here — and the terminal
  // finalizers (onStop/onError/enforceTimeout) are SEPARATE invocations with no
  // access to startBuild's local variable. This field survives create→terminal within
  // the build's lifetime (the DO is actively running the container), so finalize can
  // still PATCH the run. Strictly additive: consulted only behind explicitId/DO/PG,
  // and lost on eviction leaves behavior identical to today (no-op). The DO is keyed
  // per build, so there is no cross-build staleness.
  private activeCheckRunId: string | null = null;

  private db(): Db {
    return createDb(this.env.HYPERDRIVE.connectionString);
  }

  private async getConfig(): Promise<ManagerState | null> {
    return (await this.ctx.storage.get<ManagerState>(STORAGE_KEY_CONFIG)) ?? null;
  }

  private async setStatus(status: StoredBuildStatus): Promise<void> {
    const state = await this.getConfig();
    if (state) {
      await this.ctx.storage.put<ManagerState>(STORAGE_KEY_CONFIG, { ...state, status });
    }
  }

  /**
   * Entry point invoked over RPC by the BuildScheduler. Persists the config,
   * mints the scoped deploy + installation tokens, starts the container with
   * the build env vars, and arms the timeout alarm.
   *
   * The DB row is already `starting` — the scheduler's `claimBuildForStartWithinLimit`
   * flipped it `queued -> starting` before calling us, so there is NO post-start
   * `starting` write here: a delayed `onStart` (which the base `start()` runs
   * inside `blockConcurrencyWhile` before resolving) or a fast-exit `onStop`
   * could already have moved the row to `building`/terminal, and re-writing
   * `starting` afterward would clobber it. `onStart` lands the `instance_type`
   * (the only place it is persisted) via a `starting`-guarded CAS.
   */
  async startBuild(config: BuildConfig): Promise<void> {
    await this.ctx.storage.put<ManagerState>(STORAGE_KEY_CONFIG, {
      ...config,
      status: 'starting',
    });

    // Token mint + container start can throw *before* the timeout alarm is
    // armed. At that point neither onError nor onStop will ever fire (those only
    // run after the container is live), so without this catch the row would be
    // stuck `starting` with no alarm and no reaper — permanently consuming one
    // of the user's concurrency slots. Fail it the same way onError does so the
    // slot is freed and the queue scan is re-armed, then re-throw.
    //
    // The catch also covers the step AFTER a successful `this.start()` (arming
    // the timeout schedule). That runs before onStop's reaper is reliably
    // wired, so a throw there would mark the row failed +
    // free the slot while the container keeps running the real `void deploy`
    // CLI with a live token — publishing a deployment for a build Postgres calls
    // `failed`. Track whether start() succeeded so the catch can best-effort
    // stop() the container before finalizing. A pre-start throw (token mint)
    // must NOT stop() — nothing was started.
    let containerStarted = false;
    try {
      // Just-in-time branch-head freshness recheck BEFORE any token mint / start.
      // The push webhook checks freshness at ENQUEUE, but a missed/delayed
      // newer-push webhook can leave a stale queued build that the scheduler runs
      // and publishes. Mirror the OIDC path's gate: prove the commit is still the
      // branch head before minting VOID_TOKEN. `getBranchHeadComparisonStatus`
      // returns null (never throws) on API failure, so a transient outage drives
      // the requeue/age-fail path below rather than the catch's fail.
      const headComparison = await getBranchHeadComparisonStatus(
        this.env,
        config.installationId,
        config.repoFullName,
        config.commitSha,
        config.branch,
      );
      if (headComparison === null) {
        // Can't verify (GitHub API down / repo inaccessible). Do NOT mint or start.
        // Bounce the row back to 'queued' (guarded, so a concurrent cancel wins) and
        // let the next alarm retry — UNLESS the build has been waiting too long, in
        // which case fail it so a persistent-null can't loop forever (no container is
        // started here, so nothing would ever reap it).
        const row = await getBuild(this.db(), config.buildId);
        const ageMs = row?.created_at ? Date.now() - new Date(row.created_at).getTime() : 0;
        if (ageMs > FRESHNESS_VERIFY_MAX_AGE_MS) {
          const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
            error: 'could not verify branch head is current before timeout',
            completedAt: new Date().toISOString(),
          });
          await this.setStatus('failed');
          await this.broadcast({ type: 'status', status: 'failed' });
          // Finalize a run created on a PRIOR attempt (a capacity requeue re-runs
          // startBuild on the same build id; the persisted `builds.check_run_id`
          // survives the requeue). No-ops on a first attempt (no run yet).
          // CAS-aware (mirrors the catch site below + the 6 terminal sites): the
          // awaits above (getBranchHeadComparisonStatus) release the DO input gate,
          // so a concurrent terminalizer (terminateBuildsForProject commits an
          // out-of-band terminal status, then the cancelBuild RPC) can win the row
          // with a DIFFERENT status. PATCH 'failure' only when THIS site won the CAS;
          // on a loss finalize to the recorded outcome so GitHub never contradicts
          // the authoritative DB row.
          if (won) {
            await this.finalizeCheckRunToStatus(config, 'failed');
          } else {
            await this.finalizeCheckRunToRecordedOutcome(config);
          }
        } else {
          await requeueBuildIfStarting(this.db(), config.buildId);
        }
        await this.pokeScheduler();
        return;
      }
      if (headComparison !== 'identical') {
        // ahead/behind/diverged → the commit is no longer the branch head (superseded
        // or rolled back / force-pushed away). Cancel; do NOT mint or start.
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'cancelled', {
          error: 'commit is no longer the branch head',
          completedAt: new Date().toISOString(),
        });
        await this.setStatus('cancelled');
        await this.broadcast({ type: 'status', status: 'cancelled' });
        // Finalize a run created on a PRIOR attempt (see the aged-out branch above).
        // CAS-aware (see the aged-out branch): on a lost CAS finalize to the recorded
        // outcome so GitHub never contradicts the authoritative DB row.
        if (won) {
          await this.finalizeCheckRunToStatus(config, 'cancelled');
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
        await this.pokeScheduler();
        return;
      }
      // else 'identical' → proceed to the coverage recheck + signDeployToken + start.

      // Just-in-time GitHub App installation coverage recheck BEFORE any token
      // mint / start. The enqueue path (`installationCoversRepoInTx`) verified
      // coverage at build CREATE, but this DO mints the deploy + source tokens
      // LATER — after a queue wait that can be seconds to ~30min under capacity
      // backoff. If an uninstall / App-suspension / repo-removal webhook is
      // delivered in that window, the `github_installations` row is updated but
      // the enqueue-time check is stale. A fresh plain (non-locking) Postgres
      // read here observes the committed revocation and fails closed before we
      // mint a live deploy token, rather than relying solely on the installation
      // token mint failing once its ~55-min cache expires. A null repositoryId
      // (unprovable membership) fails closed by construction. Treat an
      // uncovered build like the non-identical freshness branch: cancel (not a
      // build failure), don't mint or start. Nothing is started yet, so there is
      // no container to tear down.
      const covered = await installationCoversRepo(
        this.db(),
        config.installationId,
        config.repositoryId,
      );
      if (!covered) {
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'cancelled', {
          error: 'github app installation no longer covers this repository',
          completedAt: new Date().toISOString(),
        });
        await this.setStatus('cancelled');
        await this.broadcast({ type: 'status', status: 'cancelled' });
        // Finalize a run created on a PRIOR attempt (see the aged-out branch above).
        // CAS-aware (see the aged-out branch): on a lost CAS finalize to the recorded
        // outcome so GitHub never contradicts the authoritative DB row.
        if (won) {
          await this.finalizeCheckRunToStatus(config, 'cancelled');
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
        await this.pokeScheduler();
        return;
      }

      // Just-in-time cancellation recheck BEFORE any token mint / start. The
      // scheduler claimed this row (`queued -> starting`) potentially seconds to
      // ~30min ago (capacity backoff); in that window a disconnect or a
      // branch/executor change could have cancelled the build out-of-band
      // (`terminateBuildsForProject` commits a terminal status, then the
      // cancelBuild RPC). The branch-head + coverage rechecks above don't catch a
      // direct cancellation, so without this we'd mint a live deploy token and
      // start the container for an already-cancelled build, burning capacity until
      // enforceTimeout. A plain READ COMMITTED read suffices — the canceller
      // commits before its RPC. Do NOT re-terminalize (the canceller already wrote
      // the terminal row); just sync the local status, poke, and return —
      // mirroring the non-identical freshness branch above.
      const row = await getBuild(this.db(), config.buildId);
      if (!row || row.status !== 'starting') {
        if (row && TERMINAL_STATUSES.includes(row.status)) {
          await this.setStatus(row.status);
          // Finalize a run created on a PRIOR attempt that this requeue is now
          // abandoning (out-of-band cancel during the queue wait). No-ops on a first
          // attempt (no run yet); on a requeue the id is in DO storage / builds row.
          await this.finalizeCheckRunToStatus(config, row.status);
        }
        await this.pokeScheduler();
        return;
      }

      // Create the GitHub Check Run now that EVERY pre-start recheck passed — this
      // build WILL start, so the run begins `in_progress`. BEST-EFFORT: a create
      // failure (returns null) must never fail or perturb the build. Two guards:
      //   (a) Idempotent reuse across requeue — a capacity-to-start error re-throws
      //       WITHOUT terminalizing, the scheduler re-queues, and startBuild re-runs
      //       on the SAME DO. We reuse the id from DO storage, or — if that best-effort
      //       cache write was lost — from the persisted `builds.check_run_id` on the
      //       `row` already read above, so a requeue never POSTs a SECOND `Void Build`
      //       run (which would orphan the first one `in_progress`).
      //   (b) SHA guard — config.commitSha is `build.commit_sha ?? ''`; a check-run
      //       POST with head_sha:'' is a guaranteed GitHub 422, so skip creation when
      //       the SHA is empty (no run to orphan; finalizers no-op on the absent id).
      // The DO-storage write is the input-gated source of truth for finalizers; the
      // Postgres write is best-effort (DO KV/DB awaits aren't input-gated). A transient
      // create failure returns null and is NOT stored, so a later requeue retries it.
      let checkRunId: string | null =
        (await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN)) ??
        this.activeCheckRunId ??
        row.check_run_id ??
        null;
      if (!checkRunId && config.commitSha) {
        checkRunId = await createCheckRun(this.env, config.installationId, config.repoFullName, {
          name: 'Void Build',
          headSha: config.commitSha,
          externalId: config.buildId,
          detailsUrl: this.projectUrl(config),
          title: 'Void build in progress',
          summary: `Building \`${config.branch}\` @ ${config.commitSha.slice(0, 7)}`,
        });
        if (checkRunId) {
          // Record the id in-memory FIRST — before the best-effort persists below — so
          // even if BOTH the DO put and the Postgres persist fail, a later terminal
          // finalizer (a separate invocation) can still recover it for this build.
          this.activeCheckRunId = checkRunId;
          // BEST-EFFORT cache of the run id. This put + the Postgres persist below
          // must NOT enter the outer build-start catch: a failure to cache check-run
          // metadata is not a build failure. If the DO-storage put rejects, the id is
          // lost for finalizers (they no-op on the absent id) but the build proceeds;
          // a later requeue re-runs createCheckRun (the idempotent reuse only kicks in
          // once the put succeeds), so this self-heals. Swallow + log, never rethrow.
          let cached = false;
          try {
            await this.ctx.storage.put<string>(STORAGE_KEY_CHECK_RUN, checkRunId);
            cached = true;
          } catch (err) {
            console.warn('startBuild: caching check_run_id in DO storage failed', err);
          }
          try {
            await setBuildCheckRunId(this.db(), config.buildId, checkRunId);
          } catch (err) {
            console.warn(
              cached
                ? 'startBuild: persisting check_run_id failed (DO cache retains it)'
                : 'startBuild: persisting check_run_id failed (DO cache also failed)',
              err,
            );
          }
        }

        // The createCheckRun fetch above yielded the DO input gate, so a cancelBuild
        // RPC could have terminalized this build mid-POST (its finalizeCheckRun ran
        // BEFORE the id was stored → no-op). Re-read the authoritative row: if it is no
        // longer 'starting', sync local status, finalize the just-created run to the
        // recorded outcome, and do NOT mint tokens / start a container. Mirrors the
        // pre-create cancel recheck above; runs only when a create POST happened.
        const recheck = await getBuild(this.db(), config.buildId);
        if (!recheck || recheck.status !== 'starting') {
          if (recheck && TERMINAL_STATUSES.includes(recheck.status)) {
            await this.setStatus(recheck.status);
            // Pass the in-hand `checkRunId`: the run was just created this invocation,
            // so this finalizes it even if both the DO put and the PG persist failed.
            await this.finalizeCheckRunToStatus(config, recheck.status, checkRunId);
          }
          await this.pokeScheduler();
          return;
        }
      }

      // Fail fast on a staging platform misconfiguration. Staging API hosts sit
      // behind CF Access and the container can't do the interactive cloudflared
      // flow, so it relies on the service-token pair being forwarded (below). If
      // staging is missing EITHER secret, the build would otherwise run all the
      // way through download/install/build and only fail at the Access edge when
      // `void deploy` calls the API — a confusing late failure that wastes a
      // container slot. Reject up front as a build failure with a clear message;
      // the catch finalizes it (failed + pokeScheduler) so the slot frees. The
      // pair is all-or-nothing: a half-configured pair is as broken as none.
      // Production isn't Access-gated, so this only applies on staging.
      if (
        this.env.PLATFORM_ENV === 'staging' &&
        !(this.env.CF_ACCESS_CLIENT_ID_STAGING && this.env.CF_ACCESS_CLIENT_SECRET_STAGING)
      ) {
        throw new Error(
          'staging build misconfigured: CF_ACCESS_CLIENT_ID_STAGING and CF_ACCESS_CLIENT_SECRET_STAGING must both be set on the staging API worker so the build can reach the Access-gated staging API',
        );
      }

      // Size the deploy token to cover the whole build (mint happens *before*
      // download + install + deploy). `timeoutMinutes: 0` means unlimited
      // wall-clock, so the shared helper falls back to the hard max; otherwise
      // it uses the plan timeout. Either way the minutes are capped at the hard
      // max so even an "unlimited" custom plan can't mint an unbounded-life
      // token, then padded with a fixed margin so the token outlives the build.
      const ttlSeconds = deployTokenTtlSecondsForBuildMinutes(config.timeoutMinutes);
      const voidToken = await signDeployToken(
        {
          projectId: config.projectId,
          userId: config.userId,
          login: config.login,
          buildId: config.buildId,
        },
        this.env.JWT_SECRET,
        { ttlSeconds },
      );
      // Repo-scope the source token to the ONE repo being built, read-only. The
      // build agent uses it solely as the Bearer to download this repo's tarball,
      // but it's injected into the container env where an untrusted dependency
      // `postinstall` could read it — a repo-scoped `{ contents: 'read' }` token
      // caps that blast radius to this single repo instead of every repo the
      // install covers. A null repositoryId (legacy/partial connection) can't be
      // scoped, so fall back to the unscoped installation-wide mint to preserve
      // compatibility; coverage is already re-verified above.
      const sourceToken =
        config.repositoryId !== null
          ? await getInstallationToken(this.env, config.installationId, {
              repositoryIds: [config.repositoryId],
              permissions: { contents: 'read' },
            })
          : await getInstallationToken(this.env, config.installationId);
      const sourceTarballUrl = generateSourceTarballUrl(config.repoFullName, config.commitSha);
      const voidApiUrl =
        this.env.PLATFORM_ENV === 'staging'
          ? 'https://api.staging.void.cloud'
          : 'https://api.void.cloud';

      // Staging API hosts sit behind CF Access; the `void deploy` child can't do
      // the interactive `cloudflared` flow (no TTY/binary in the container), so
      // forward the staging service-token pair under the names the CLI reads
      // (`CF_ACCESS_CLIENT_ID`/`SECRET`). Production isn't Access-gated, so this
      // only applies on staging and only when the secrets are configured. These
      // are scrubbed from untrusted install children and re-injected only into
      // the trusted deploy child by the build-agent (see `SCRUBBED_ENV_VARS`).
      const stagingAccess: Record<string, string> =
        this.env.PLATFORM_ENV === 'staging' &&
        this.env.CF_ACCESS_CLIENT_ID_STAGING &&
        this.env.CF_ACCESS_CLIENT_SECRET_STAGING
          ? {
              CF_ACCESS_CLIENT_ID: this.env.CF_ACCESS_CLIENT_ID_STAGING,
              CF_ACCESS_CLIENT_SECRET: this.env.CF_ACCESS_CLIENT_SECRET_STAGING,
            }
          : {};

      // Per-build, unguessable agent secret. The agent (parent process) presents
      // it on its control POSTs (/logs, /status, /cancel); the DO rejects any
      // request without it. The build-agent scrubs AGENT_TOKEN (along with
      // DO_LOG_URL/SOURCE_TOKEN) out of the env handed to untrusted repo
      // install/build child processes, so a malicious postinstall can't forge
      // build status even if it discovers the DO endpoint.
      const agentToken = crypto.randomUUID();
      await this.ctx.storage.put<string>(STORAGE_KEY_AGENT_TOKEN, agentToken);

      // Real Container env-var mechanism: set `this.envVars` then start(). The
      // base class forwards these into the container's `start({ env })` call.
      this.envVars = {
        BUILD_ID: config.buildId,
        PROJECT_ID: config.projectId,
        PROJECT_SLUG: config.projectSlug,
        SOURCE_TARBALL_URL: sourceTarballUrl,
        SOURCE_TOKEN: sourceToken,
        VOID_TOKEN: voidToken,
        VOID_API_URL: voidApiUrl,
        VOID_PROJECT: config.projectSlug,
        VOID_CLI_VERSION: PINNED_VOID_CLI_VERSION,
        DO_LOG_URL: 'https://manager/logs',
        AGENT_TOKEN: agentToken,
        // Commit/source metadata for `void deploy`. The extracted tarball has no
        // `.git`, so the CLI's `getGitCommit` would record a NULL commit — leaving
        // the deployment unlinked (onStop's getDeploymentByProjectAndCommit can't
        // match) and breaking same-SHA redelivery dedup. The CLI reads GITHUB_SHA
        // FIRST (before any git inspection — this is exactly how the GitHub Actions
        // executor stamps it), and GITHUB_REPOSITORY/GITHUB_REF feed the source
        // links, so forwarding these stamps the deployment correctly. They're the
        // build's own commit/repo/branch (non-secret), and NOT scrubbed from the
        // untrusted child env — the repo already knows its own identity.
        GITHUB_SHA: config.commitSha,
        GITHUB_REPOSITORY: config.repoFullName,
        GITHUB_REF: `refs/heads/${config.branch}`,
        ...stagingAccess,
      };

      // Flip the marker BEFORE awaiting start(): the base `start()` launches the
      // container (`startContainerIfNotRunning`) and THEN runs
      // `blockConcurrencyWhile(() => this.onStart())` before it resolves, so a
      // throw from our `onStart` (its `markBuildBuildingIfStarting` is a
      // Hyperdrive/Postgres write that can throw transiently) rejects start()
      // AFTER the container is already live. If the marker only flipped on the
      // line after a resolved start(), that onStart-reject would be treated as a
      // pre-launch failure and the catch would skip teardown, leaving the
      // container running the real `void deploy` CLI with a live token while
      // Postgres records the build `failed` — pinning a global fleet slot until
      // the idle net. A genuine pre-launch throw still can't stop a non-existent
      // container: the capacity error originates in `startContainerIfNotRunning`
      // BEFORE any launch and the catch re-throws it before the stop block, and
      // token-mint throws happen above this line with the marker still false.
      containerStarted = true;
      await this.start();

      // Wall-clock timeout. Use the base Container's public scheduler instead of
      // writing the DO alarm directly: a DO has a SINGLE alarm and the base
      // Container OWNS it to drive its monitor loop (polling container state and
      // dispatching onStop on exit). Overwriting that alarm with our own wake
      // time would starve the base loop, so onStop might never fire and a
      // healthy build could never finalize. `schedule()` stores a row the base
      // alarm loop invokes when due, calling our `enforceTimeout` callback
      // without disturbing the base cadence.
      //
      // A timeout is ALWAYS armed, even for a custom "unlimited" plan
      // (`timeoutMinutes: 0`): the base `sleepAfter` idle-stop never fires for a
      // busy container, so without this an orphaned build could run far past any
      // sane ceiling. 0 falls back to the hard max; a positive plan timeout is
      // capped at it. Mirrors `deployTokenTtlSecondsForBuildMinutes`, so the
      // build can never outlive its deploy token.
      const effectiveTimeout =
        config.timeoutMinutes > 0
          ? Math.min(config.timeoutMinutes, DEPLOY_TOKEN_HARD_MAX_MINUTES)
          : DEPLOY_TOKEN_HARD_MAX_MINUTES;
      await this.schedule(effectiveTimeout * 60, 'enforceTimeout');
    } catch (error) {
      if (isContainerCapacityError(error)) {
        // Capacity-to-start (fleet full), not a build failure. Nothing was started
        // (containerStarted is false here), so there's nothing to stop. Leave the row
        // as the scheduler claimed it and re-throw so the scheduler catch requeues it.
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      // Mirror enforceTimeout / cancelBuild: set the LOCAL terminal status FIRST
      // (DO storage — can't fail on Hyperdrive) so the onStop that the teardown
      // below triggers sees the terminal status and won't clobber it, THEN tear
      // the container down. If the container already launched, a throw here (the
      // onStart-reject inside start(), or schedule arming) must force it down
      // before we finalize as failed — otherwise it keeps running the real
      // `void deploy` CLI with a live token while Postgres says `failed`, pinning
      // a fleet slot until the idle net. `forceStopContainer` SIGTERMs THEN
      // SIGKILLs (idempotent / TERMINAL-safe) so a SIGTERM-ignoring build agent
      // can't outlive the failure; `stop()` alone is SIGTERM-only. Best-effort so
      // a teardown failure doesn't mask the original error.
      await this.setStatus('failed');
      if (containerStarted) {
        await this.forceStopContainer();
      }
      // CAS terminal-if-active (NOT an unconditional write): a concurrent cancel
      // (terminateBuildsForProject commits 'cancelled' out-of-band, then the
      // cancelBuild RPC) can have already driven this row terminal. An
      // unconditional updateBuildStatus('failed') would clobber that 'cancelled'
      // to 'failed'; the CAS no-ops on an already-terminal row (the slot is
      // already freed). The DB write + broadcast run inside a try whose `finally`
      // ALWAYS pokes the scheduler — mirroring onStop/onError/enforceTimeout — so a
      // transient Hyperdrive/Postgres throw on the terminal write can't skip the
      // queue re-arm and strand the slot until the stale reaper.
      try {
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
          error: message,
          completedAt: new Date().toISOString(),
        });
        await this.broadcast({ type: 'status', status: 'failed' });
        // Finalize the check-run here too: the run is created BEFORE signDeployToken /
        // this.start() / the staging-misconfig check, so a throw in that window marks
        // the build `failed` HERE and no onStop ever finalizes it (force-stop →
        // onStop's terminal-status guard no-op). Without this the run is stranded
        // `in_progress` forever. The capacity-error branch re-throws above and never
        // reaches here, so the requeued build correctly keeps its run `in_progress`.
        // CAS-aware: only PATCH 'failure' when THIS site won the terminal transition.
        // On a lost CAS (the row was terminalized out-of-band, e.g. a concurrent
        // cancel) read the authoritative row and finalize to ITS outcome, so GitHub
        // never contradicts the DB.
        if (won) {
          await this.finalizeCheckRun(config, 'failure', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build failed',
            summary: message,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
      throw error;
    }
  }

  /**
   * The project's public traffic URL — used as the check-run `details_url`. Staging
   * and production serve user traffic on different base domains (`staging.void.app`
   * vs `void.app`), so the link must be env-aware: read the per-environment
   * `SITE_DOMAIN` binding (the same source the deploy-URL output uses), falling back
   * to the production constant when unset.
   */
  private projectUrl(config: BuildConfig): string {
    return `https://${config.projectSlug}.${this.env.SITE_DOMAIN ?? SITE_DOMAIN}`;
  }

  /**
   * Finalize this build's GitHub Check Run with a terminal conclusion. BEST-EFFORT:
   * resolves the run id from, in order, an explicit in-hand id → the in-memory
   * `activeCheckRunId` → input-gated DO storage → the persisted `builds.check_run_id`,
   * so a DO-storage miss (eviction, a rejected cache put, a transient loss) OR a dual
   * persist failure cannot strand an already-created run `in_progress`. No-ops when no
   * source has an id (no run was created, or create failed), and never throws so the
   * caller's `finally { pokeScheduler() }` always runs. `completeCheckRun` already
   * swallows internally; the extra try/catch is belt-and-suspenders.
   */
  private async finalizeCheckRun(
    config: BuildConfig,
    conclusion: CheckRunConclusion,
    opts: { detailsUrl?: string; title: string; summary: string },
    explicitId?: string | null,
  ): Promise<void> {
    // Prefer the in-hand id, then the in-memory field (survives create→terminal within
    // the build's lifetime), then the durable sources. The first two are authoritative
    // even when BOTH the DO-storage put and the Postgres persist failed.
    let checkRunId =
      explicitId ??
      this.activeCheckRunId ??
      (await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN));
    if (!checkRunId) {
      // DO storage missed — recover the id from Postgres (written by
      // `setBuildCheckRunId` at create). Best-effort: a read failure leaves the id
      // unknown and the run unfinalized (cosmetic), never throwing out of finalize.
      try {
        checkRunId = (await getBuild(this.db(), config.buildId))?.check_run_id ?? undefined;
      } catch (err) {
        console.warn('finalizeCheckRun: builds.check_run_id fallback read failed', err);
      }
    }
    if (!checkRunId) {
      return;
    }
    try {
      await completeCheckRun(this.env, config.installationId, config.repoFullName, checkRunId, {
        conclusion,
        ...opts,
      });
    } catch (err) {
      console.warn('finalizeCheckRun: best-effort PATCH failed', err);
    }
  }

  /**
   * Finalize the check-run to the AUTHORITATIVE build status — used on the rare
   * lost-CAS path (the row was terminalized out-of-band, e.g. an admin/disconnect
   * cancel) and the post-create cancellation recheck. Maps the DB's terminal
   * status to its check-run conclusion so GitHub always matches the recorded
   * outcome instead of this site's assumed one. No-ops (returns) for a non-terminal
   * status; delegates to `finalizeCheckRun`, which itself no-ops on an absent id
   * and never throws.
   */
  private async finalizeCheckRunToStatus(
    config: BuildConfig,
    status: string,
    explicitId?: string | null,
  ): Promise<void> {
    const conclusion =
      status === 'complete'
        ? 'success'
        : status === 'cancelled'
          ? 'cancelled'
          : status === 'failed'
            ? 'failure'
            : null;
    if (!conclusion) {
      return;
    }
    await this.finalizeCheckRun(
      config,
      conclusion as CheckRunConclusion,
      {
        detailsUrl: this.projectUrl(config),
        title: `Void build ${conclusion === 'success' ? 'succeeded' : conclusion}`,
        summary: `Build ${status}.`,
      },
      explicitId,
    );
  }

  /**
   * Lost-CAS finalize: read the AUTHORITATIVE build status and finalize the check-run
   * to it. Used at every terminal site when `markBuildTerminalIfActive` lost (the row
   * was terminalized out-of-band). BEST-EFFORT — the `getBuild` is wrapped so a
   * transient read failure logs and returns instead of throwing out of the terminal
   * handler (which would skip the PATCH AND propagate); the slot is freed regardless
   * by the caller's `finally { pokeScheduler() }`.
   */
  private async finalizeCheckRunToRecordedOutcome(config: BuildConfig): Promise<void> {
    let status: string | undefined;
    try {
      status = (await getBuild(this.db(), config.buildId))?.status;
    } catch (err) {
      console.warn('finalizeCheckRunToRecordedOutcome: getBuild failed (best-effort)', err);
      return;
    }
    if (status) {
      await this.finalizeCheckRunToStatus(config, status);
    }
  }

  override async onStart(): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    // CAS `starting -> building` and land the `instance_type` (its only persist
    // point — the scheduler's claim set `starting` without it). The base
    // `start()` runs onStart inside `blockConcurrencyWhile` before resolving, so
    // a fast-exit `onStop` can have already driven the row terminal; this guard
    // is the authoritative protection against resurrecting it. Only sync the
    // in-memory status (used by the other lifecycle guards) when the CAS won, so
    // a no-op onStart can't downgrade an already-terminal in-memory status.
    const moved = await markBuildBuildingIfStarting(this.db(), config.buildId, {
      instanceType: config.instanceType,
    });
    if (!moved) {
      return;
    }
    await this.setStatus('building');
    await this.broadcast({ type: 'status', status: 'building' });
  }

  override async onStop(params: {
    exitCode: number;
    reason: 'exit' | 'runtime_signal';
  }): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }

    const current = config.status;
    if (TERMINAL_STATUSES.includes(current)) {
      // Already finalized (e.g. timeout alarm fired and stopped the container).
      // Don't overwrite the recorded outcome; just poke the scheduler.
      await this.pokeScheduler();
      return;
    }

    const db = this.db();
    const completedAt = new Date().toISOString();
    // Mirror enforceTimeout / cancelBuild: set the LOCAL terminal status FIRST
    // (DO storage — can't fail on Hyperdrive), then run the Postgres terminal
    // write + broadcast inside a try whose `finally` ALWAYS pokes the scheduler.
    // `markBuildTerminalIfActive` has no internal try/catch, so a transient
    // Postgres throw here must NOT skip pokeScheduler() — otherwise the row would
    // stay ACTIVE and pin the concurrency slot until the 75m idle reaper even
    // though the container has already exited (and, on exit 0, the deploy is
    // live). The container already exited, so there is no stop() to make.
    if (params.exitCode === 0) {
      await this.setStatus('complete');
      try {
        // The deployment link is BEST-EFFORT and must run inside this try. The
        // lookup is a Hyperdrive/Postgres read that can throw on a transient
        // error AFTER `void deploy` already exited 0; if it threw outside the
        // try (as it used to), `onStop` would reject before `setStatus` and the
        // `finally`, leaving the build row ACTIVE with no scheduler poke — the
        // deploy live but the concurrency slot pinned until the 75m idle reaper.
        // Swallow the lookup error and finalize 'complete' with a null link
        // instead; the row is still terminalized and the slot freed.
        let deploymentId: string | null = null;
        try {
          const deployment = await getDeploymentByProjectAndCommit(
            db,
            config.projectId,
            config.commitSha,
          );
          deploymentId = deployment?.id ?? null;
        } catch (err) {
          console.error('onStop: deployment lookup failed; finalizing without link', err);
        }
        // CAS terminal-if-active: the in-memory guard above is defense in depth;
        // this is the authoritative check against clobbering an outcome a
        // concurrent terminal write (e.g. the timeout) already recorded in the DB.
        const won = await markBuildTerminalIfActive(db, config.buildId, 'complete', {
          exitCode: 0,
          completedAt,
          deploymentId,
        });
        await this.broadcast({ type: 'status', status: 'complete' });
        // CAS-aware finalize: only PATCH 'success' when THIS exit-0 won the terminal
        // transition. On a lost CAS (the row was terminalized out-of-band first, e.g.
        // an admin cancel committed 'cancelled') finalizing 'success' would contradict
        // the DB. Read the authoritative row and finalize to ITS recorded outcome so
        // GitHub matches the DB. `details_url` comes from `projectSlug` (already in
        // hand) so a deployment lookup miss does NOT cost the link.
        if (won) {
          await this.finalizeCheckRun(config, 'success', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build succeeded',
            summary: deploymentId ? 'Deployment is live.' : 'Build complete.',
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
    } else {
      await this.setStatus('failed');
      try {
        const won = await markBuildTerminalIfActive(db, config.buildId, 'failed', {
          error: `build exited with code ${params.exitCode} (${params.reason})`,
          exitCode: params.exitCode,
          completedAt,
        });
        await this.broadcast({ type: 'status', status: 'failed' });
        // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
        // the out-of-band recorded outcome so GitHub matches the DB.
        if (won) {
          await this.finalizeCheckRun(config, 'failure', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build failed',
            summary: `Build exited with code ${params.exitCode}.`,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
    }
  }

  override async onError(error: unknown): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    if (TERMINAL_STATUSES.includes(config.status)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Mirror onStop / enforceTimeout / cancelBuild: set the LOCAL terminal status
    // FIRST (DO storage — can't fail on Hyperdrive), then run the Postgres terminal
    // write + broadcast inside a try whose `finally` ALWAYS pokes the scheduler.
    // `markBuildTerminalIfActive` has no internal try/catch, so a transient
    // Postgres throw here must NOT skip pokeScheduler() — otherwise the row stays
    // ACTIVE and pins the concurrency slot until the 75m idle reaper even though
    // the container has already errored.
    await this.setStatus('failed');
    try {
      const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
        error: message,
        completedAt: new Date().toISOString(),
      });
      await this.broadcast({ type: 'status', status: 'failed' });
      // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
      // the out-of-band recorded outcome so GitHub matches the DB.
      if (won) {
        await this.finalizeCheckRun(config, 'failure', {
          detailsUrl: this.projectUrl(config),
          title: 'Void build failed',
          summary: message,
        });
      } else {
        await this.finalizeCheckRunToRecordedOutcome(config);
      }
    } finally {
      await this.pokeScheduler();
    }
  }

  /**
   * Force the container down on a timeout/cancel path. `stop()` only sends a
   * SIGTERM — which the agent (PID 1) now handles cooperatively — but a wedged or
   * adversarial child (e.g. a `postinstall` that blocks uninterruptibly or
   * ignores SIGTERM) can survive it, and `@cloudflare/containers` never escalates
   * to SIGKILL on its own. So follow the best-effort SIGTERM with `destroy()`
   * (SIGKILL), which a PID-1 process cannot mask. Without the escalation a hung
   * build keeps running and permanently pins one of the fleet's global
   * `max_instances` slots — capacity starvation across every tenant, since the
   * STALE reaper only re-cancels rows still ACTIVE (this row is already terminal).
   *
   * Both calls are best-effort + idempotent: the build is already recorded
   * terminal locally, so neither a no-op stop()/destroy() on an already-exited
   * container nor a transient teardown error must propagate past here. `destroy()`
   * triggers onStop, whose TERMINAL_STATUSES guard makes it a safe no-op (it only
   * pokes the scheduler).
   */
  private async forceStopContainer(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // Best-effort SIGTERM — the build is already recorded terminal locally.
    }
    try {
      await this.destroy();
    } catch {
      // Best-effort SIGKILL — container already gone / mid-teardown.
    }
  }

  /**
   * Wall-clock build timeout, invoked by the base Container's alarm loop when
   * the schedule armed in `startBuild` comes due (NOT an `alarm()` override —
   * the base owns the single DO alarm to drive its container monitor + onStop
   * dispatch, so we MUST NOT hijack it). Force-stops the container and fails the
   * build. `stop()` ultimately triggers onStop, which sees the terminal status
   * set here and won't clobber it.
   *
   * Public + named so the base scheduler can resolve it as a callback. Takes the
   * scheduler's `(payload, schedule)` args (unused here).
   */
  async enforceTimeout(): Promise<void> {
    const config = await this.getConfig();
    if (!config || TERMINAL_STATUSES.includes(config.status)) {
      return;
    }
    // Set the LOCAL terminal status first (DO storage — can't fail on Hyperdrive)
    // so onStop, triggered by the teardown below, sees the terminal status and
    // won't clobber it. Container teardown + the scheduler poke are then made
    // INDEPENDENT of the Postgres terminal write: `markBuildTerminalIfActive` has
    // no internal try/catch, so a Hyperdrive/Postgres throw must NOT skip
    // forceStopContainer() (leaving a timed-out container running with a
    // still-honored deploy token + a pinned fleet slot) or pokeScheduler()
    // (stranding the freed concurrency slot). forceStopContainer SIGTERMs then
    // SIGKILLs so a SIGTERM-ignoring build can't outlive its timeout.
    await this.setStatus('failed');
    await this.forceStopContainer();
    try {
      const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
        error: 'build timed out',
        completedAt: new Date().toISOString(),
      });
      await this.broadcast({ type: 'status', status: 'failed' });
      // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
      // the out-of-band recorded outcome so GitHub matches the DB.
      if (won) {
        await this.finalizeCheckRun(config, 'failure', {
          detailsUrl: this.projectUrl(config),
          title: 'Void build failed',
          summary: 'build timed out',
        });
      } else {
        await this.finalizeCheckRunToRecordedOutcome(config);
      }
    } finally {
      // Free the slot even if the DB write (or broadcast) threw.
      await this.pokeScheduler();
    }
  }

  /**
   * Internal RPC cancel — invoked by the API (github.ts) when a project is
   * disconnected or its branch/executor changes, orphaning this build. Trusted
   * DO→DO / API→DO path (like startBuild), so NO agent secret is required; the
   * agent-authenticated POST /cancel path stays for the in-container agent.
   *
   * Mirrors enforceTimeout's teardown but with a cancel outcome, using the CAS
   * (`markBuildTerminalIfActive`) so it can't clobber an outcome a concurrent
   * onStop/timeout already recorded. Idempotent: a no-op once the build is
   * already terminal. Best-effort stop() then pokes the scheduler so the freed
   * concurrency slot is reclaimed.
   */
  async cancelBuild(reason = 'build cancelled'): Promise<void> {
    const config = await this.getConfig();
    const shouldTerminalize = config != null && !TERMINAL_STATUSES.includes(config.status);
    // Set the LOCAL terminal status first (DO storage — can't fail on Hyperdrive)
    // so onStop, triggered by stop() below, sees the terminal status and won't
    // clobber it. Only when the build isn't already terminal — a late cancel
    // against an already-finalized row must NOT downgrade the recorded outcome.
    if (shouldTerminalize) {
      await this.setStatus('cancelled');
    }
    // Container teardown is UNCONDITIONAL and independent of the Postgres write:
    // `markBuildTerminalIfActive` has no internal try/catch, so a Hyperdrive
    // throw must NOT skip forceStopContainer() (leaving the orphaned container
    // running + a pinned fleet slot) or pokeScheduler() (stranding the freed
    // slot). forceStopContainer SIGTERMs then SIGKILLs (idempotent) so a
    // SIGTERM-ignoring orphan can't survive the cancel.
    await this.forceStopContainer();
    try {
      if (shouldTerminalize) {
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'cancelled', {
          error: reason,
          completedAt: new Date().toISOString(),
        });
        await this.broadcast({ type: 'status', status: 'cancelled' });
        // Only when terminalizing: a late cancel against an already-terminal row must
        // not re-PATCH and clobber the recorded outcome. `config` is non-null here
        // (shouldTerminalize requires config != null). CAS-aware: finalize 'cancelled'
        // only when THIS site won; otherwise finalize to the out-of-band recorded
        // outcome so GitHub matches the DB.
        if (won) {
          await this.finalizeCheckRun(config, 'cancelled', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build cancelled',
            summary: reason,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      }
    } finally {
      // Free the slot even if the DB write (or broadcast) threw.
      await this.pokeScheduler();
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade();
    }
    // Agent control endpoints are authenticated with the per-build secret so a
    // malicious repo build step can't POST forged logs/status to the DO even if
    // it discovers the endpoint URL.
    if (
      request.method === 'POST' &&
      (path === '/logs' || path === '/status' || path === '/cancel')
    ) {
      if (!(await this.isAuthorizedAgent(request))) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      if (path === '/logs') {
        return this.handleLogs(request);
      }
      if (path === '/status') {
        return this.handleStatus(request);
      }
      return this.handleCancel();
    }

    // Anything else is forwarded to the container (health checks, etc.).
    return super.fetch(request);
  }

  /**
   * Constant-time check of the per-build agent secret presented on a control
   * request (`Authorization: Bearer <token>` or `X-Agent-Token`). Returns false
   * if no secret was minted yet (build not started) or it doesn't match.
   */
  private async isAuthorizedAgent(request: Request): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(STORAGE_KEY_AGENT_TOKEN);
    if (!expected) {
      return false;
    }
    const header = request.headers.get('Authorization');
    const presented =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : (request.headers.get('X-Agent-Token') ?? '');
    return timingSafeEqual(presented, expected);
  }

  // --- log storage + fan-out ---

  private ensureLogTable(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL,
        stream TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`,
    );
  }

  private async handleLogs(request: Request): Promise<Response> {
    const lines = (await request.json()) as ReadonlyArray<BuildLogLine>;
    this.ensureLogTable();
    for (const entry of lines) {
      this.ctx.storage.sql.exec(
        'INSERT INTO logs (line, stream, ts) VALUES (?, ?, ?)',
        entry.line,
        entry.stream,
        entry.ts,
      );
    }
    // Evict everything older than the most-recent MAX_STORED_LOG_LINES rows so the
    // table (and the WS replay that loads it) stays bounded for the build's
    // lifetime. `seq` is a monotonic AUTOINCREMENT, so the kept window is always
    // the contiguous tail; once-per-batch keeps this O(1) statements, not O(line).
    if (lines.length > 0) {
      this.ctx.storage.sql.exec(
        'DELETE FROM logs WHERE seq <= (SELECT MAX(seq) FROM logs) - ?',
        MAX_STORED_LOG_LINES,
      );
    }
    for (const entry of lines) {
      await this.broadcast({ type: 'log', ...entry });
    }
    return Response.json({ ok: true });
  }

  private async handleStatus(request: Request): Promise<Response> {
    const body = (await request.json()) as { status?: StoredBuildStatus };
    const config = await this.getConfig();
    if (!body.status || !config) {
      return Response.json({ ok: false }, { status: 400 });
    }
    // The agent may only report *non-terminal* PROGRESS ('building'|'deploying').
    // Terminal outcomes (complete/failed/cancelled) are decided exclusively by
    // the trusted DO lifecycle — onStop (container exit code), the timeout
    // alarm, or an authenticated cancel — so a build step can never forge a
    // 'complete' that frees the slot while the container is still running.
    // Anything else (incl. 'queued'/'starting') is rejected so a buggy/malicious
    // agent can't write an arbitrary lifecycle state.
    if (body.status !== 'building' && body.status !== 'deploying') {
      return Response.json({ ok: false, error: 'status not allowed' }, { status: 400 });
    }
    // Don't let a late progress report clobber an already-finalized build (local
    // fast path; the CAS below is the authoritative cross-process guard).
    if (TERMINAL_STATUSES.includes(config.status)) {
      return Response.json({ ok: false, error: 'build already finalized' }, { status: 409 });
    }
    // Guarded CAS: only write the progress status while the DB row is still
    // active. A CAS-miss means a concurrent terminalizer (push-supersede,
    // disconnect, branch/executor change, app removal) already drove the row
    // terminal out-of-band while the DO's local status still said active. An
    // unconditional write here would resurrect that `cancelled` row to
    // 'deploying' and re-enable the bound deploy token, letting a superseded
    // runner publish stale code. On a CAS-miss, tear down via cancelBuild — its
    // own `markBuildTerminalIfActive` CAS no-ops against the already-terminal row
    // (NO clobber) and best-effort stop()s the orphaned container + pokes the
    // scheduler. Never write `cancelled` directly here (that reintroduces the
    // unguarded-write bug class).
    const moved = await markBuildProgressIfActive(this.db(), config.buildId, body.status);
    if (!moved) {
      await this.cancelBuild('build superseded');
      return Response.json({ ok: false, error: 'build no longer active' }, { status: 409 });
    }
    await this.setStatus(body.status);
    await this.broadcast({ type: 'status', status: body.status });
    return Response.json({ ok: true });
  }

  private async handleCancel(): Promise<Response> {
    // The agent-authenticated POST /cancel path shares the same teardown as the
    // internal RPC; delegate so the cancel outcome + CAS guard live in one place.
    await this.cancelBuild();
    return Response.json({ ok: true });
  }

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernatable accept — the DO can sleep between log batches and still
    // receive the socket on wake.
    this.ctx.acceptWebSocket(server);

    // Replay every stored log line, then a caught-up marker, then the socket
    // live-streams subsequent broadcasts.
    this.ensureLogTable();
    const rows = this.ctx.storage.sql
      .exec<{ line: string; stream: string; ts: number }>(
        'SELECT line, stream, ts FROM logs ORDER BY seq ASC',
      )
      .toArray();
    for (const row of rows) {
      server.send(JSON.stringify({ type: 'log', line: row.line, stream: row.stream, ts: row.ts }));
    }
    server.send(JSON.stringify({ type: 'caught_up' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(message: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Dead socket — ignore; the runtime will surface a close event.
      }
    }
  }

  private async pokeScheduler(): Promise<void> {
    try {
      await this.env.BUILD_SCHEDULER.get(this.env.BUILD_SCHEDULER.idFromName('global')).fetch(
        'https://scheduler/poke',
        { method: 'POST' },
      );
    } catch {
      // Best-effort — the scheduler's own poke-on-next-webhook backstops this.
    }
  }
}

/**
 * Larger build container for paid plans. Identical behavior to BuildManager —
 * it exists only as a distinct container-enabled DO class so wrangler.jsonc can
 * bind it to a bigger static `instance_type` (standard-4). @cloudflare/containers
 * has no per-start sizing, so a second class is the only way to offer a second
 * container size. Routing (which class a build uses) is decided elsewhere by the
 * build's persisted instance_type.
 */
export class BuildManagerLarge extends BuildManager {}
