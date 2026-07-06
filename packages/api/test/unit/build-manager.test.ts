import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `@cloudflare/containers` Container base class isn't available in unit tests.
// Stub it with a minimal shape the manager relies on: ctx/env wiring plus
// `start`/`stop`/`fetch` (the latter as the "forward to container" fallback).
//
// The real base Container OWNS the single DO alarm to drive its monitor loop +
// onStop dispatch. The manager must NOT override `alarm()`; instead it arms the
// timeout via the base `schedule(seconds, methodName)` API, and the base alarm
// loop invokes that named method when due. The stub mirrors exactly that: it
// records scheduled callbacks, and `_runDueSchedules()` invokes them the way
// the base alarm loop would (see container.js:1441-1463). `alarm()` here is the
// base-owned handler — the manager never overrides it, so a base alarm before
// the deadline is a no-op for build state.
const containerCalls = {
  started: 0,
  stopped: 0,
  destroyed: 0,
  baseAlarms: 0,
};
type ScheduledTask = { whenSeconds: number; callback: string };
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    envVars: Record<string, string> = {};
    defaultPort?: number;
    enableInternet?: boolean;
    sleepAfter?: string | number;
    _schedules: Array<ScheduledTask> = [];
    // Tracks whether the container has been LAUNCHED. The base `start()` launches
    // the container in `startContainerIfNotRunning` and only THEN runs onStart, so
    // a post-launch onStart reject leaves a LIVE container — modeled by this flag
    // staying true after start() rejects.
    _containerRunning = false;
    // Settable per-test: backs `container.getTcpPort(port).fetch(url)` (the
    // non-starting port fetch pollLogs uses). Called as (url, port) to match the
    // assertions in the pollLogs suite.
    _portFetch: ((url: string, port: number) => Promise<Response>) | null = null;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    // Mirrors the real base `this.container = ctx.container`. `.running` reflects the
    // launched/stopped flag the stub already tracks (set by start()/stop()/destroy()).
    // `getTcpPort().fetch()` is the NON-starting port fetch — it never auto-starts,
    // modeling that the real raw port fetch FAILS (rather than starting) when the
    // container is down.
    get container() {
      return {
        running: this._containerRunning,
        getTcpPort: (port: number) => ({
          fetch: (url: string) => {
            if (!this._portFetch) {
              throw new Error('container port fetch not stubbed');
            }
            return this._portFetch(url, port);
          },
        }),
      };
    }
    // Faithful model of the base `start()` (container.js:554-570): it LAUNCHES the
    // container (`startContainerIfNotRunning`, ~1321) and THEN runs onStart inside
    // `ctx.blockConcurrencyWhile` (567-569) BEFORE start() resolves. So onStart
    // runs after the container is live but before start() returns, and an onStart
    // throw rejects start() while the container is already running. Modeling this
    // is what makes the startBuild catch's post-launch teardown testable: a bare
    // counter-only stub could never distinguish a PRE-launch failure (capacity /
    // token mint) from a POST-launch onStart reject.
    async start(): Promise<void> {
      containerCalls.started += 1;
      this._containerRunning = true;
      await (this as unknown as { onStart(): Promise<void> }).onStart();
    }
    async stop(): Promise<void> {
      containerCalls.stopped += 1;
      this._containerRunning = false;
    }
    // SIGKILL escalation. The real base only SIGTERMs in stop(); destroy() is the
    // sole SIGKILL and is what guarantees a SIGTERM-ignoring container is killed.
    async destroy(): Promise<void> {
      containerCalls.destroyed += 1;
      this._containerRunning = false;
    }
    async fetch(): Promise<Response> {
      return new Response('container', { status: 200 });
    }
    // Public base scheduler. Stores the task; the base alarm loop (modeled by
    // `_runDueSchedules`) invokes the named method when due.
    async schedule(whenSeconds: number, callback: string): Promise<void> {
      this._schedules.push({ whenSeconds, callback });
    }
    // Base-owned alarm handler. The manager never overrides it; a fire before
    // any schedule is due must not touch build state. Returns the base bookkeep.
    async alarm(): Promise<void> {
      containerCalls.baseAlarms += 1;
    }
    // Test helper: invoke every scheduled callback whose delay has elapsed,
    // exactly as the base alarm loop would when the deadline arrives.
    async _runDueSchedules(): Promise<void> {
      const due = this._schedules;
      this._schedules = [];
      for (const task of due) {
        const fn = (this as unknown as Record<string, () => Promise<void>>)[task.callback];
        await fn.call(this);
      }
    }
  },
}));

// db.ts — capture every status write so the state machine can be asserted.
type StatusWrite = {
  id: string;
  status: string;
  opts?: {
    error?: string;
    exitCode?: number;
    deploymentId?: string | null;
    instanceType?: string | null;
  };
};
const ACTIVE_BUILD_STATUSES = ['starting', 'building', 'deploying'];
const dbState = {
  writes: [] as Array<StatusWrite>,
  // Authoritative per-build DB status, so the CAS helpers
  // (markBuildBuildingIfStarting / markBuildTerminalIfActive) can model the real
  // `UPDATE ... WHERE status = ?` guard: a write that doesn't match the guard is
  // a no-op (records no write and returns false), exactly like Postgres.
  status: new Map<string, string>(),
  // deployment returned by getDeploymentByProjectAndCommit
  deployment: null as { id: string } | null,
  // `created_at` (ISO string) returned by getBuild for the build row. Drives the
  // freshness-recheck age bound: a null-comparison on a FRESH build requeues, on
  // an OLD build (older than FRESHNESS_VERIFY_MAX_AGE_MS) fails. Defaults to now.
  createdAt: new Date().toISOString(),
  // records every build returned to `queued` via the guarded requeue CAS so the
  // freshness-recheck null path can be asserted.
  requeued: [] as Array<string>,
  // Drives `installationCoversRepo`: the JIT App-installation coverage recheck
  // in startBuild. Default true so the happy path proceeds to mint + start; the
  // coverage tests flip it false (uninstall/suspension/repo-removal raced the
  // queue wait) to assert the build fails closed (cancelled, no mint, no start).
  installationCovered: true,
};
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  // Unconditional write — mirrors the real `updateBuildStatus` (no status guard).
  updateBuildStatus: vi.fn(async (_db: unknown, id: string, status: string, opts?: unknown) => {
    dbState.status.set(id, status);
    dbState.writes.push({ id, status, opts: opts as StatusWrite['opts'] });
  }),
  // CAS: `starting -> building` ONLY if the row is still `starting`. Returns
  // whether it updated (true) so onStart can avoid resurrecting a terminal row.
  markBuildBuildingIfStarting: vi.fn(
    async (_db: unknown, id: string, opts?: { instanceType?: string | null }) => {
      if (dbState.status.get(id) !== 'starting') {
        return false;
      }
      dbState.status.set(id, 'building');
      dbState.writes.push({ id, status: 'building', opts: opts as StatusWrite['opts'] });
      return true;
    },
  ),
  // CAS: apply a terminal status ONLY if the row is currently active. Returns
  // whether it updated (true). A second/late terminal write is a no-op.
  markBuildTerminalIfActive: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: unknown) => {
      const current = dbState.status.get(id);
      if (current === undefined || !ACTIVE_BUILD_STATUSES.includes(current)) {
        return false;
      }
      dbState.status.set(id, status);
      dbState.writes.push({ id, status, opts: opts as StatusWrite['opts'] });
      return true;
    },
  ),
  // CAS: apply a non-terminal progress status ONLY if the row is currently
  // active. Returns whether it updated (true). A forged/late progress report
  // against a row a concurrent terminalizer already drove terminal is a no-op
  // (records no write, returns false) — exactly like the real
  // `UPDATE ... WHERE status IN (active)` guard.
  markBuildProgressIfActive: vi.fn(async (_db: unknown, id: string, status: string) => {
    const current = dbState.status.get(id);
    if (current === undefined || !ACTIVE_BUILD_STATUSES.includes(current)) {
      return false;
    }
    dbState.status.set(id, status);
    dbState.writes.push({ id, status, opts: undefined });
    return true;
  }),
  getDeploymentByProjectAndCommit: vi.fn(async () => dbState.deployment),
  // Returns the build row so startBuild's rechecks can read it: `created_at`
  // age-bounds a persistently-null branch comparison (freshness path), and
  // `status` drives the JIT cancellation recheck. `status` reflects the
  // authoritative dbState map so a concurrent cancel committed before this read
  // is observed. Returns null when no row exists for the id.
  getBuild: vi.fn(async (_db: unknown, id: string) => {
    const status = dbState.status.get(id);
    if (status === undefined) {
      return null;
    }
    return { id, created_at: dbState.createdAt, status };
  }),
  // Guarded CAS `starting -> queued`: the freshness recheck requeues a build it
  // could not verify (transient GitHub API failure) so the next alarm retries.
  // Records the id so the null path can be asserted.
  requeueBuildIfStarting: vi.fn(async (_db: unknown, id: string) => {
    if (dbState.status.get(id) !== 'starting') {
      return false;
    }
    dbState.status.set(id, 'queued');
    dbState.requeued.push(id);
    return true;
  }),
  // JIT App-installation coverage recheck (fresh, non-locking Postgres read).
  // Fails closed on a null repository id, exactly like the real helper.
  installationCoversRepo: vi.fn(
    async (_db: unknown, _installationId: string, repositoryId: string | null) => {
      if (repositoryId === null) {
        return false;
      }
      return dbState.installationCovered;
    },
  ),
}));

// Token mints — deterministic fakes so startBuild can be exercised offline.
// The mock is declared inline in the factory (vi.mock is hoisted, so it can't
// close over an outer variable); its call args (incl. the optional opts) are
// inspected later via `vi.mocked(signDeployToken)` for the TTL sizing.
vi.mock('../../src/auth/deploy-token.ts', () => ({
  signDeployToken: vi.fn(
    async (
      _ident: { projectId: string; userId: string; login: string; buildId?: string },
      _secret: string,
      _opts?: { ttlSeconds?: number },
    ) => 'deploy-token',
  ),
  // Hard ceiling on the build's wall-clock timeout (and deploy-token life) —
  // mirrors the real constant so the always-armed timeout cap holds.
  DEPLOY_TOKEN_HARD_MAX_MINUTES: 60,
  // Real (pure) TTL formula — the manager calls this to size the token. Mirror
  // the implementation in deploy-token.ts so the sizing assertions hold.
  deployTokenTtlSecondsForBuildMinutes: (timeoutMinutes: number) => {
    const buildMinutes = timeoutMinutes > 0 ? timeoutMinutes : Infinity;
    const cappedMinutes = Math.min(buildMinutes, 60);
    return cappedMinutes * 60 + 5 * 60;
  },
}));
vi.mock('../../src/github/installation-token.ts', () => ({
  // Real constants (the module is mocked wholesale): the log-tail suite routes
  // completeCheckRun to the REAL implementation, which builds its PATCH URL and
  // version header from these.
  GITHUB_API_BASE: 'https://api.github.com',
  GITHUB_API_VERSION: '2026-03-10',
  getInstallationToken: vi.fn(async () => 'install-token'),
  generateSourceTarballUrl: vi.fn(
    (repo: string, sha: string) => `https://api.github.com/repos/${repo}/tarball/${sha}`,
  ),
  // JIT branch-head freshness recheck. Default 'identical' so every existing
  // happy-path test proceeds to mint + start unchanged; the freshness-recheck tests override
  // it per-case ('ahead'/'behind'/'diverged' → cancel, null → requeue/age-fail).
  getBranchHeadComparisonStatus: vi.fn(async () => 'identical'),
}));
// check-run.ts is mocked here so startBuild's BEST-EFFORT check-run create is INERT
// in this suite — it must not make outbound `fetch` calls or consume a
// `getInstallationToken` mock. `createCheckRun` returns null by default (no run
// created → finalizers no-op), keeping every existing lifecycle assertion unchanged.
// The real create/finalize wiring is covered by test/integration/api-check-runs.test.ts.
vi.mock('../../src/github/check-run.ts', () => ({
  createCheckRun: vi.fn(async () => null),
  completeCheckRun: vi.fn(async () => false),
}));

// Helpers from the container build agent. Importing the .mjs only pulls in its
// exported helpers — the entrypoint guard keeps `main()` from running the
// control server / spawning anything on import. Types come from the sibling
// build-agent.d.mts (NodeNext pairs it with the .mjs).
import {
  BUILDER_GID,
  BUILDER_HOME,
  BUILDER_UID,
  builderCacheEnv,
  childSpawnOptions,
  closeControlServer,
  getBufferedLogLines,
  getPendingLogLineCount,
  installShutdownHandlers,
  MAX_BUFFERED_LOG_LINES,
  MAX_PARTIAL_LINE_CHARS,
  MAX_PENDING_LOG_LINES,
  parseProcStatusUid,
  pipeStream,
  record,
  runBuild,
  SCRUBBED_ENV_VARS,
  sanitizeChildEnv,
} from '../../container/build-agent.mjs';
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import {
  BuildManager,
  CHECK_RUN_LOG_TAIL_MAX_BYTES,
  CHECK_RUN_OUTPUT_TEXT_MAX_BYTES,
  formatLogTailMarkdown,
  MAX_STORED_LOG_LINES,
} from '../../src/build-manager.ts';
import type { BuildConfig } from '../../src/build-types.ts';
import {
  getDeploymentByProjectAndCommit,
  installationCoversRepo,
  markBuildBuildingIfStarting,
  markBuildTerminalIfActive,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { completeCheckRun } from '../../src/github/check-run.ts';
import {
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from '../../src/github/installation-token.ts';

// --- in-memory SQLite + storage + websocket fakes ---

type LogRow = { seq: number; line: string; stream: string; ts: number };

function makeStubCtx() {
  const kv = new Map<string, unknown>();
  let alarmTime: number | null = null;
  const logs: Array<LogRow> = [];
  let seq = 0;
  const sockets: Array<FakeWebSocket> = [];

  const sql = {
    exec(query: string, ...bindings: Array<unknown>) {
      if (query.startsWith('CREATE TABLE')) {
        return { toArray: () => [] };
      }
      if (query.startsWith('INSERT INTO logs')) {
        seq += 1;
        logs.push({
          seq,
          line: bindings[0] as string,
          stream: bindings[1] as string,
          ts: bindings[2] as number,
        });
        return { toArray: () => [] };
      }
      if (query.startsWith('DELETE FROM logs')) {
        // Mirror `DELETE FROM logs WHERE seq <= (SELECT MAX(seq) FROM logs) - ?`:
        // keep only the most-recent N rows by seq. Without modeling this, the cap
        // would silently no-op in tests (cf. the rowCount/PGlite lesson).
        const keep = bindings[0] as number;
        if (logs.length > 0) {
          const maxSeq = logs.reduce((m, r) => (r.seq > m ? r.seq : m), 0);
          const threshold = maxSeq - keep;
          for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].seq <= threshold) {
              logs.splice(i, 1);
            }
          }
        }
        return { toArray: () => [] };
      }
      if (query.startsWith('SELECT MAX(seq)')) {
        // Mirror `SELECT MAX(seq) AS max FROM logs`: NULL (→ JS null) when empty.
        const max = logs.length > 0 ? logs.reduce((m, r) => (r.seq > m ? r.seq : m), 0) : null;
        return { toArray: () => [{ max }] };
      }
      if (query.startsWith('SELECT COUNT(*)')) {
        // Mirror `SELECT COUNT(*) AS count FROM logs` (check-run log-tail total).
        return { toArray: () => [{ count: logs.length }] };
      }
      if (query.startsWith('SELECT line FROM logs ORDER BY seq DESC')) {
        // Mirror `SELECT line FROM logs ORDER BY seq DESC LIMIT ?` (check-run log
        // tail): newest-first, bounded. Must be modeled BEFORE the generic branch,
        // which would misread the LIMIT binding as a `seq > ?` bound.
        const limit = bindings[0] as number;
        return {
          toArray: () =>
            logs
              .slice()
              .sort((a, b) => b.seq - a.seq)
              .slice(0, limit)
              .map((r) => ({ line: r.line })),
        };
      }
      if (query.startsWith('SELECT')) {
        // Honor a `WHERE seq > ?` bound when present (the GET /logs poll read);
        // without modeling the filter it would silently no-op in tests (cf. the
        // rowCount/PGlite lesson). The WS-replay SELECT carries no binding, so
        // `since` defaults to -Infinity and every row passes.
        const since = bindings.length > 0 ? (bindings[0] as number) : Number.NEGATIVE_INFINITY;
        return {
          toArray: () =>
            logs
              .slice()
              .sort((a, b) => a.seq - b.seq)
              .filter((r) => r.seq > since),
        };
      }
      return { toArray: () => [] };
    },
  };

  return {
    _logs: logs,
    _sockets: sockets,
    _kv: kv,
    storage: {
      sql,
      get: vi.fn(async (k: string) => kv.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        kv.set(k, v);
      }),
      getAlarm: vi.fn(async () => alarmTime),
      setAlarm: vi.fn(async (t: number) => {
        alarmTime = t;
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
    },
    acceptWebSocket: vi.fn((ws: FakeWebSocket) => {
      sockets.push(ws);
    }),
    getWebSockets: vi.fn(() => sockets),
  };
}

class FakeWebSocket {
  sent: Array<string> = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function makeEnv() {
  const schedulerStub = { fetch: vi.fn(async () => new Response('ok')) };
  return {
    HYPERDRIVE: { connectionString: 'postgres://fake' },
    JWT_SECRET: 'secret',
    PLATFORM_ENV: undefined,
    BUILD_SCHEDULER: {
      idFromName: vi.fn((n: string) => ({ name: n })),
      get: vi.fn(() => schedulerStub),
    },
  } as unknown as ApiEnv['Bindings'] & {
    BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> };
  };
}

function makeConfig(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildId: 'b1',
    projectId: 'p1',
    projectSlug: 'my-app',
    userId: 'u1',
    login: 'octocat',
    commitSha: 'sha1',
    branch: 'main',
    repoFullName: 'owner/repo',
    installationId: 'inst1',
    repositoryId: 'repo1',
    instanceType: 'standard-1',
    timeoutMinutes: 10,
    ...overrides,
  };
}

function makeManager(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildManager(ctx as unknown as ConstructorParameters<typeof BuildManager>[0], env);
}

/** Read the timeout tasks the manager armed via the base `schedule()` API. */
function scheduledTasks(m: BuildManager): Array<ScheduledTask> {
  return (m as unknown as { _schedules: Array<ScheduledTask> })._schedules;
}

/** Fire the base alarm loop so any due scheduled callbacks run (timeout path). */
async function runDueSchedules(m: BuildManager): Promise<void> {
  await (m as unknown as { _runDueSchedules: () => Promise<void> })._runDueSchedules();
}

function lastWrite(status: string): StatusWrite | undefined {
  return [...dbState.writes].reverse().find((w) => w.status === status);
}

/** Read the per-build agent secret the manager stored at startBuild(). */
function agentToken(ctx: ReturnType<typeof makeStubCtx>): string {
  return ctx._kv.get('agentToken') as string;
}

/** Build an authenticated agent control request (Bearer agent token). */
function agentRequest(
  ctx: ReturnType<typeof makeStubCtx>,
  url: string,
  init: RequestInit = {},
): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${agentToken(ctx)}` },
  });
}

// Provide WebSocketPair as a global for the upgrade path.
class FakeWebSocketPair {
  0 = new FakeWebSocket();
  1 = new FakeWebSocket();
}

// The CF Workers runtime accepts `new Response(null, { status: 101, webSocket })`
// for WebSocket upgrades, but the Node/undici `Response` used in unit tests
// rejects status 101. Shim a lenient Response that records status + webSocket so
// the upgrade path (real CF code) can be exercised here.
class FakeUpgradeResponse {
  status: number;
  webSocket: unknown;
  constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}
const RealResponse = globalThis.Response;

beforeEach(() => {
  dbState.writes = [];
  // Model the scheduler's claim: `claimBuildForStartWithinLimit` flips the row
  // `queued -> starting` BEFORE calling startBuild, so the DB row is already
  // `starting` when the DO runs. Every test uses buildId 'b1' (makeConfig).
  dbState.status = new Map<string, string>([['b1', 'starting']]);
  dbState.deployment = null;
  dbState.createdAt = new Date().toISOString();
  dbState.requeued = [];
  dbState.installationCovered = true;
  containerCalls.started = 0;
  containerCalls.stopped = 0;
  containerCalls.destroyed = 0;
  containerCalls.baseAlarms = 0;
  vi.clearAllMocks();
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = FakeWebSocketPair;
  // Patch Response to tolerate status 101 (WebSocket upgrade) while delegating
  // every other construction to the real implementation.
  (globalThis as unknown as { Response: unknown }).Response = new Proxy(RealResponse, {
    construct(target, args) {
      const init = args[1] as { status?: number } | undefined;
      if (init?.status === 101) {
        return new FakeUpgradeResponse(args[0], init as { webSocket?: unknown });
      }
      return Reflect.construct(target, args, target);
    },
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
  });
});

afterEach(() => {
  (globalThis as unknown as { Response: unknown }).Response = RealResponse;
});

describe('BuildManager.startBuild', () => {
  it('persists config, sets env vars, starts the container, arms timeout — and does NOT write starting', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(containerCalls.started).toBe(1);
    // Build env-var contract handed to the container agent.
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.BUILD_ID).toBe('b1');
    expect(envVars.PROJECT_ID).toBe('p1');
    expect(envVars.PROJECT_SLUG).toBe('my-app');
    expect(envVars.VOID_PROJECT).toBe('my-app');
    expect(envVars.VOID_TOKEN).toBe('deploy-token');
    expect(envVars.SOURCE_TOKEN).toBe('install-token');
    expect(envVars.SOURCE_TARBALL_URL).toBe('https://api.github.com/repos/owner/repo/tarball/sha1');
    expect(envVars.VOID_API_URL).toBe('https://api.void.cloud');
    // The fallback Void CLI version is PINNED (never `latest`) so a moving npm
    // dist-tag can't change deploy behavior with no repo diff.
    expect(envVars.VOID_CLI_VERSION).toBeDefined();
    expect(envVars.VOID_CLI_VERSION).not.toBe('latest');
    expect(envVars.VOID_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(envVars.DO_LOG_URL).toBe('https://manager/logs');
    // Commit/source metadata forwarded so `void deploy` stamps the deployment's
    // commit (the tarball has no `.git`; the CLI reads GITHUB_SHA first). Without
    // these the deployment records a NULL commit and onStop can't link the build.
    expect(envVars.GITHUB_SHA).toBe('sha1');
    expect(envVars.GITHUB_REPOSITORY).toBe('owner/repo');
    expect(envVars.GITHUB_REF).toBe('refs/heads/main');
    // Timeout armed via the base scheduler (10 min = 600s), NOT a raw setAlarm:
    // the base Container owns the single DO alarm to drive its monitor/onStop
    // loop, so the manager must never write the alarm directly.
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    // onStart arms the log pull-loop (first tick at 1s) before startBuild arms the
    // timeout (10 min = 600s); both go through the base scheduler, never setAlarm.
    expect(scheduledTasks(m)).toEqual([
      { whenSeconds: 1, callback: 'pollLogs' },
      { whenSeconds: 10 * 60, callback: 'enforceTimeout' },
    ]);
    // The deploy token is bound to THIS build so the deploy endpoint can reject
    // it once the build is no longer active (superseded/cancelled by a newer push).
    const ident = vi.mocked(signDeployToken).mock.calls[0]?.[0];
    expect(ident?.buildId).toBe('b1');
    expect(ident?.projectId).toBe('p1');
    // startBuild must NOT write `starting` to Postgres: the scheduler's claim
    // (`claimBuildForStartWithinLimit`) already set it. A redundant post-start
    // `starting` write could downgrade a row a fast onStart/onStop already moved
    // past `starting`, stranding it and leaking a concurrency slot.
    expect(dbState.writes.some((w) => w.status === 'starting')).toBe(false);
    // The only write startBuild makes is onStart's `starting -> building` CAS,
    // which runs INSIDE the base `start()` (before it resolves) — its sole persist
    // point for the instance_type (the claim flips status without it).
    expect(lastWrite('building')?.opts?.instanceType).toBe('standard-1');
  });

  it('uses the staging API URL when PLATFORM_ENV=staging', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    // Staging requires the CF Access service token (see fail-fast below), so set
    // it for the happy-path URL assertion.
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.VOID_API_URL).toBe('https://api.staging.void.cloud');
  });

  it('forwards the staging CF Access service token into the container (staging hosts are Access-gated)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    // The CLI reads the un-suffixed names; the worker holds the *_STAGING secrets.
    expect(envVars.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
    expect(envVars.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
  });

  it('does NOT forward CF Access creds on production builds (api.void.cloud is not Access-gated)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    // Production env, but the secrets happen to be set: they must NOT leak in.
    Object.assign(env as object, {
      PLATFORM_ENV: undefined,
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(envVars.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
  });

  it('fails fast (does NOT start) on staging when the service token is unconfigured', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    (env as unknown as { PLATFORM_ENV?: string }).PLATFORM_ENV = 'staging';
    const m = makeManager(ctx, env);
    // Staging is Access-gated and the container can't auth without the service
    // token, so an unconfigured staging worker is a platform misconfiguration:
    // fail the build up front rather than burning a slot to fail at the Access edge.
    await expect(m.startBuild(makeConfig())).rejects.toThrow(/staging build misconfigured/);
    expect(containerCalls.started).toBe(0);
    const failed = lastWrite('failed');
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toMatch(/CF_ACCESS_CLIENT_ID_STAGING/);
    // Slot freed: the scheduler was poked and the row is not left active.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails fast on staging when the service token is half-configured (id without secret)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      // CF_ACCESS_CLIENT_SECRET_STAGING intentionally absent — a half pair is as
      // broken as none (cfAccessHeaders requires both).
    });
    const m = makeManager(ctx, env);
    await expect(m.startBuild(makeConfig())).rejects.toThrow(/staging build misconfigured/);
    expect(containerCalls.started).toBe(0);
    expect(lastWrite('failed')?.id).toBe('b1');
  });

  it('arms the hard-max timeout when timeoutMinutes is 0 (unlimited)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig({ timeoutMinutes: 0 }));
    // Even an "unlimited" custom plan gets a hard ceiling: the base `sleepAfter`
    // idle-stop never fires for a busy container, so an orphaned build could
    // otherwise run unbounded. Falls back to DEPLOY_TOKEN_HARD_MAX_MINUTES (60).
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(scheduledTasks(m)).toContainEqual({ whenSeconds: 60 * 60, callback: 'enforceTimeout' });
  });

  it('caps the timeout at the hard max when timeoutMinutes exceeds it', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig({ timeoutMinutes: 120 }));
    // A plan timeout above the hard max (60) is clamped to it.
    expect(scheduledTasks(m)).toContainEqual({ whenSeconds: 60 * 60, callback: 'enforceTimeout' });
  });

  // The deploy token is minted *before* download + install + deploy, so its
  // TTL must cover the whole build (plan timeout + margin), not a fixed 15 min.
  it('sizes the deploy token TTL to the plan build timeout + margin', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // sponsored plan: 20-min build timeout. Token must outlive it.
    await m.startBuild(makeConfig({ timeoutMinutes: 20 }));

    const opts = vi.mocked(signDeployToken).mock.calls[0]?.[2];
    expect(opts?.ttlSeconds).toBe(20 * 60 + 5 * 60); // 25 min
    // Strictly longer than the old fixed 15-min TTL.
    expect(opts?.ttlSeconds).toBeGreaterThan(15 * 60);
  });

  it('caps the deploy token TTL at the hard max for unlimited (timeoutMinutes=0) builds', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // custom plan: 0 = unlimited wall-clock. The token must still be bounded.
    await m.startBuild(makeConfig({ timeoutMinutes: 0 }));

    const opts = vi.mocked(signDeployToken).mock.calls[0]?.[2];
    // HARD_MAX (60 min) + margin (5 min) = 65 min, and never unbounded.
    expect(opts?.ttlSeconds).toBe(60 * 60 + 5 * 60);
  });

  it('fails the build (freeing the concurrency slot) when start-up throws before the timeout alarm is armed', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // A pre-alarm failure: token mint rejects. onError/onStop never fire here
    // (the container isn't running yet), so startBuild itself must fail the row
    // and free the slot — otherwise it stays `starting` forever.
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('token mint failed'));

    // (a) the RPC rejects so the scheduler's defense-in-depth catch also engages.
    await expect(m.startBuild(makeConfig())).rejects.toThrow('token mint failed');

    // (b) the row was marked failed with the error message.
    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('token mint failed');

    // (c) the scheduler was poked so the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    // (d) the row is not left in an active status (would leak a concurrency slot).
    const activeWrite = dbState.writes.find((w) =>
      ['starting', 'building', 'deploying'].includes(w.status),
    );
    expect(activeWrite).toBeUndefined();

    // (e) a PRE-start failure must NOT stop() — the container never started,
    // so there's nothing to stop. start() itself was never reached either.
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
  });

  // a failure AFTER a successful this.start() (now only arming the timeout
  // schedule — the redundant post-start `starting` write was removed) must stop
  // the already-running container before finalizing — otherwise it keeps running
  // the real `void deploy` CLI with a live token and can publish a deployment
  // while Postgres records the build as `failed`. The row must still be marked
  // failed and the scheduler poked, and stop() must not mask the original error.
  it('stops the container when a step AFTER start() throws, then still fails + pokes', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Arming the timeout schedule throws — this runs AFTER this.start() has
    // launched the container. The catch then issues
    // markBuildTerminalIfActive('failed'), which must succeed against the still-
    // active 'starting' row (default mock impl records it).
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');
    expect(scheduleSpy).toHaveBeenCalled();

    // (a) the container was started, then stopped because the post-start step threw.
    expect(containerCalls.started).toBe(1);
    expect(containerCalls.stopped).toBe(1);

    // (b) the build is recorded failed with the original error (stop() didn't mask it).
    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('postgres write failed');

    // (c) the scheduler was poked so the slot frees + the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    scheduleSpy.mockRestore();
  });

  // Slot-safe finalization: if the terminal Postgres write in the startBuild catch
  // ITSELF hits a transient outage, pokeScheduler must STILL fire (it lives in a
  // `finally`) so the queue scan re-arms — otherwise the row is stranded `starting`
  // and pins the user's slot until the stale reaper. Mirrors onStop/onError/timeout.
  it('still pokes the scheduler when the terminal write throws in the startBuild catch (slot-safe)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Enter the catch via a post-start failure, then make the terminal CAS write
    // ALSO throw (the transient-outage-on-finalize case the finally must survive).
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('terminal write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow();

    // Poked despite the terminal-write throw → the slot frees + the queue scan
    // re-arms instead of stranding the row until the reaper.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    scheduleSpy.mockRestore();
  });

  // even if stop() itself throws on the post-start failure path, the ORIGINAL
  // error must propagate (stop() is best-effort and must not mask it), and the
  // build must still be finalized as failed.
  it('does not let a stop() failure mask the original post-start error', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Force the post-start schedule step to throw, and make stop() also throw.
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));
    const stopSpy = vi
      .spyOn(m as unknown as { stop: () => Promise<void> }, 'stop')
      .mockRejectedValueOnce(new Error('container stop failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');
    expect(stopSpy).toHaveBeenCalled();

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('postgres write failed');

    scheduleSpy.mockRestore();
    stopSpy.mockRestore();
  });

  // Load-shedding: when the global BuildManager fleet is at its `max_instances`
  // cap, `@cloudflare/containers` throws its capacity error out of start(). That
  // is transient platform pressure, NOT a build failure — the manager must NOT
  // mark the row failed (which would race the scheduler's requeue) and must NOT
  // stop() (nothing started). It re-throws so the scheduler's catch requeues it.
  it('does NOT fail or stop on the container-capacity error from start(); re-throws (load shed)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(
        new Error('there is no container instance that can be provided to this durable object'),
      );

    await expect(m.startBuild(makeConfig())).rejects.toThrow(/no container instance/);
    expect(startSpy).toHaveBeenCalled();

    // (a) the row was NOT marked failed — only the `starting` config persist from
    // startBuild's head ran; no status write reached Postgres.
    expect(lastWrite('failed')).toBeUndefined();
    expect(dbState.writes).toEqual([]);
    // The DB row is left exactly as the scheduler claimed it (`starting`).
    expect(dbState.status.get('b1')).toBe('starting');

    // (b) nothing was started, so nothing was stopped.
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);

    // (c) the scheduler was NOT poked from the capacity path — the scheduler's own
    // catch handles the requeue, and a poke would only churn the alarm.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).not.toHaveBeenCalled();

    startSpy.mockRestore();
  });

  // The container LAUNCHES, then onStart's `markBuildBuildingIfStarting` (a
  // Hyperdrive/Postgres write) throws — so the base start() rejects AFTER the
  // container is already live (modeled by the stub start() running onStart before
  // resolving). The catch must FORCE the live container down (SIGTERM→SIGKILL),
  // not leak it running the real `void deploy` CLI with a live token while
  // Postgres records the build `failed` and a fleet slot is pinned until the idle
  // net. Discriminator for the fix: if `containerStarted` only flipped after a
  // resolved start(), this onStart-reject would be treated as pre-launch and
  // skip the teardown (stopped/destroyed stay 0).
  it('force-stops the live container + fails + pokes when onStart throws inside start()', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // onStart's CAS write throws. The stub start() has already marked the
    // container running by the time it calls onStart, so this rejects start()
    // with the container live.
    vi.mocked(markBuildBuildingIfStarting).mockRejectedValueOnce(
      new Error('postgres write failed'),
    );

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');

    // (a) the container DID launch and was then force-stopped (SIGTERM + SIGKILL).
    expect(containerCalls.started).toBe(1);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);

    // (b) the build is recorded failed (CAS, against the still-`starting` row that
    //     onStart never moved) with the original error.
    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('postgres write failed');
    expect(dbState.status.get('b1')).toBe('failed');

    // (c) slot freed: scheduler poked so the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  // A genuine PRE-launch failure (token mint throws BEFORE `containerStarted`
  // flips, above `await this.start()`): the manager fails the row + pokes but
  // must NOT stop()/destroy() a container that never launched. (Case (c).)
  it('does NOT tear down anything on a pre-launch failure (token mint throws before start())', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Token mint rejects — this runs ABOVE the `containerStarted = true` line, so
    // the catch sees `containerStarted === false` and skips teardown entirely.
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('token mint failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('token mint failed');

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('token mint failed');
    // Nothing launched, nothing torn down.
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(containerCalls.destroyed).toBe(0);
    // Slot freed: scheduler poked so the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  // the startBuild catch finalizes via the CAS `markBuildTerminalIfActive`,
  // NOT an unconditional write. If a concurrent cancel committed 'cancelled'
  // out-of-band (terminateBuildsForProject → cancelBuild RPC) while startBuild
  // was failing, an unconditional updateBuildStatus('failed') would clobber it.
  // The CAS must no-op on the already-terminal row (status stays 'cancelled'),
  // and pokeScheduler must still fire (the slot is already freed).
  it('does NOT clobber a concurrently-cancelled row in the startBuild catch', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // start() throws a non-capacity error; the concurrent cancel commits
    // 'cancelled' to the DB row before the catch's terminal write runs.
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementationOnce(async () => {
        dbState.status.set('b1', 'cancelled');
        throw new Error('image pull failed');
      });

    await expect(m.startBuild(makeConfig())).rejects.toThrow('image pull failed');

    // The CAS no-opped against the already-terminal row: status stays 'cancelled',
    // and the catch recorded NO 'failed' write (it would have clobbered the cancel).
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes.some((w) => w.status === 'failed')).toBe(false);
    // The scheduler is still poked so the freed slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    startSpy.mockRestore();
  });

  // `sleepAfter` is an IDLE safety-net, not the wall-clock cap. It must sit
  // ABOVE the deploy-token hard max so a legitimately busy build that runs up to
  // the hard max is never idle-stopped before `enforceTimeout` fires. (The bug:
  // a fixed '30m' sleepAfter could stop a 60-min custom-plan build at 30m.)
  it('sizes sleepAfter ABOVE the deploy-token hard max', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Effective sleepAfter (minutes) parsed from the configured '<n>m' string.
    const sleepAfter = (m as unknown as { sleepAfter: string }).sleepAfter;
    expect(sleepAfter).toMatch(/^\d+m$/);
    const sleepAfterMinutes = Number.parseInt(sleepAfter, 10);
    // DEPLOY_TOKEN_HARD_MAX_MINUTES is mocked to 60 above; the idle net must be
    // strictly larger so it can never cut a build at the hard max short.
    expect(sleepAfterMinutes).toBeGreaterThan(60);
  });

  // the scheduler claimed the row (`queued -> starting`) potentially ~30min
  // ago; a disconnect / branch-executor change could have cancelled it out-of-
  // band in that window. startBuild must re-read builds.status AFTER the branch-
  // head + coverage rechecks and BEFORE minting the deploy token: a non-'starting'
  // row mints no token, starts no container, syncs the local terminal status, and
  // pokes the scheduler — mirroring the non-identical freshness branch.
  it('mints no token + starts no container when the row was cancelled after the claim', async () => {
    // Freshness + coverage both pass (defaults), but the build row is already
    // 'cancelled' by the time startBuild re-reads it.
    dbState.status.set('b1', 'cancelled');
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // NO deploy token minted and NO container started.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    // The row was NOT re-terminalized (the canceller already wrote it); status
    // stays 'cancelled' and no new terminal write was recorded by startBuild.
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes).toEqual([]);
    // The local DO status was synced to the terminal status so a later onStart/
    // onStop can't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    // The scheduler was poked so the freed slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });
});

// The container build agent uses SOURCE_TOKEN only as the Bearer to download
// the ONE repo's tarball, but it is injected into the container env where a
// malicious dependency `postinstall` could read it. To cap that blast radius,
// startBuild mints the source token REPO-SCOPED + read-only when the connection
// carries a numeric repository id; a null (legacy/partial) id can't be scoped,
// so it falls back to the unscoped installation-wide mint for compatibility.
describe('BuildManager.startBuild source-token scoping', () => {
  it('mints a repo-scoped, read-only source token when repositoryId is non-null', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ repositoryId: 'repo1' }));

    // The SOURCE_TOKEN mint is scoped to exactly this repo with contents:read.
    // Signature: getInstallationToken(env, installationId, opts).
    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), 'inst1', {
      repositoryIds: ['repo1'],
      permissions: { contents: 'read' },
    });
    // The build still starts (the scope is additive; the happy path is unchanged).
    expect(containerCalls.started).toBe(1);
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.SOURCE_TOKEN).toBe('install-token');
  });

  it('passes the connection repositoryId straight through to the scope', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ repositoryId: 'repo-42' }));

    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), 'inst1', {
      repositoryIds: ['repo-42'],
      permissions: { contents: 'read' },
    });
  });

  it('never mints a SCOPED source token when repositoryId is null (unscoped fallback path)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // A null repository id fails the coverage recheck closed BEFORE the mint, so
    // the scoped source-token call must never happen. The fallback (unscoped)
    // call carries no third `opts` arg — assert no call passed scoping opts.
    await m.startBuild(makeConfig({ repositoryId: null }));

    const scopedCall = vi
      .mocked(getInstallationToken)
      .mock.calls.find((call) => call[2] !== undefined);
    expect(scopedCall).toBeUndefined();
    expect(containerCalls.started).toBe(0);
  });
});

// The container executor starts from the queued row's stored commit_sha
// with NO freshness recheck. The push webhook checks at ENQUEUE, but a
// missed/delayed newer-push webhook can leave a stale queued build the scheduler
// runs and publishes. startBuild must do a JIT branch-head recheck BEFORE
// minting VOID_TOKEN (mirroring the OIDC path): only 'identical' proceeds;
// ahead/behind/diverged cancels; null requeues (or age-fails) — and in every
// non-identical case NO token is minted and NO container is started.
describe('BuildManager.startBuild freshness recheck', () => {
  for (const comparison of ['ahead', 'behind', 'diverged'] as const) {
    it(`cancels (no mint, no start) when the branch head is '${comparison}' (stale commit)`, async () => {
      vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(comparison);
      const ctx = makeStubCtx();
      const env = makeEnv();
      const m = makeManager(ctx, env);

      await m.startBuild(makeConfig());

      // The build was cancelled via the CAS — the commit is no longer the head.
      const cancelled = lastWrite('cancelled');
      expect(cancelled).toBeDefined();
      expect(cancelled?.id).toBe('b1');
      expect(cancelled?.opts?.error).toMatch(/no longer the branch head/);
      expect(dbState.status.get('b1')).toBe('cancelled');
      // NO deploy token was minted and NO container was started.
      expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
      expect(containerCalls.started).toBe(0);
      expect(containerCalls.stopped).toBe(0);
      // The scheduler was poked so the freed slot is reclaimed.
      expect(
        (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
          .get,
      ).toHaveBeenCalled();
    });
  }

  it('requeues a FRESH build (no mint, no start) when the head comparison is unverifiable (null)', async () => {
    // GitHub compare API unreachable → null. A recently-created build is bounced
    // back to `queued` (guarded CAS) so the next alarm retries it.
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date().toISOString(); // fresh
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // Requeued via the guarded CAS — not failed, not cancelled.
    expect(dbState.requeued).toEqual(['b1']);
    expect(dbState.status.get('b1')).toBe('queued');
    expect(lastWrite('failed')).toBeUndefined();
    expect(lastWrite('cancelled')).toBeUndefined();
    // NO mint, NO start.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    // Scheduler poked so the alarm retries.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails an OLD build (older than the max age) when the head comparison stays unverifiable (null)', async () => {
    // A persistently-null comparison can't loop forever: no container is started
    // on this path, so nothing would ever reap it. Past the max age, fail it.
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    // 31 min old > FRESHNESS_VERIFY_MAX_AGE_MS (30 min).
    dbState.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toMatch(/could not verify branch head/);
    expect(dbState.status.get('b1')).toBe('failed');
    // Not requeued — it was terminalized instead.
    expect(dbState.requeued).toEqual([]);
    // NO mint, NO start.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it("proceeds to mint + start when the branch head is 'identical' (default)", async () => {
    // The default mock returns 'identical', so startBuild proceeds exactly as the
    // happy-path tests expect: token minted, container started, timeout armed.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(vi.mocked(signDeployToken)).toHaveBeenCalledOnce();
    expect(containerCalls.started).toBe(1);
    expect(scheduledTasks(m)).toContainEqual({ whenSeconds: 10 * 60, callback: 'enforceTimeout' });
  });
});

// startBuild mints the deploy + source tokens AFTER a queue wait (seconds to
// ~30min under capacity backoff). The enqueue-time `installationCoversRepoInTx`
// check is stale by then: a TOCTOU where an uninstall / App-suspension /
// repo-removal webhook commits its `github_installations` update during that
// window must NOT result in a deploy after access was revoked. startBuild does
// a fresh, non-locking Postgres coverage re-read BEFORE minting — only a covered
// install proceeds; an uncovered (or null-repo-id) install fails closed
// (cancelled), with NO token minted and NO container started.
describe('BuildManager.startBuild installation coverage recheck (TOCTOU)', () => {
  it('cancels (no mint, no start) when the App installation no longer covers the repo', async () => {
    // An uninstall/suspension/repo-removal raced the queue wait — the row is no
    // longer covered. The freshness gate still says 'identical' (default mock).
    dbState.installationCovered = false;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // Cancelled via the CAS — coverage was revoked.
    const cancelled = lastWrite('cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled?.id).toBe('b1');
    expect(cancelled?.opts?.error).toMatch(/installation no longer covers/i);
    expect(dbState.status.get('b1')).toBe('cancelled');
    // NO deploy token minted and NO container started.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    // The coverage helper was consulted with this build's installation + repo id.
    expect(vi.mocked(installationCoversRepo)).toHaveBeenCalledWith(
      expect.anything(),
      'inst1',
      'repo1',
    );
    // Scheduler poked so the freed slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails closed (cancels) when the connection carries a null repository id', async () => {
    // A legacy/partial connection with no repository id can't prove membership.
    // The helper fails closed on a null id regardless of dbState.installationCovered.
    dbState.installationCovered = true;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ repositoryId: null }));

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
  });

  it('proceeds to mint + start when the installation still covers the repo (happy path)', async () => {
    dbState.installationCovered = true;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(vi.mocked(installationCoversRepo)).toHaveBeenCalledWith(
      expect.anything(),
      'inst1',
      'repo1',
    );
    expect(vi.mocked(signDeployToken)).toHaveBeenCalledOnce();
    expect(containerCalls.started).toBe(1);
    expect(scheduledTasks(m)).toContainEqual({ whenSeconds: 10 * 60, callback: 'enforceTimeout' });
  });
});

describe('BuildManager.onStop', () => {
  it('exit code 0 → complete and links the deployment', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = []; // ignore the startBuild write
    dbState.deployment = { id: 'dpl_123' };

    await m.onStop({ exitCode: 0, reason: 'exit' });

    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.exitCode).toBe(0);
    expect(complete?.opts?.deploymentId).toBe('dpl_123');
    // Scheduler poked so the next queued build can start.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('non-zero exit code → failed with the exit code and reason', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.opts?.exitCode).toBe(137);
    expect(failed?.opts?.error).toMatch(/137/);
  });

  it('does not overwrite an already-terminal status (timeout then onStop)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // Timeout fires first → failed (via the base scheduler invoking enforceTimeout).
    await runDueSchedules(m);
    dbState.writes = [];

    // The container's own onStop fires afterward with a signal exit.
    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });

    // No new status write — the timeout outcome stands.
    expect(dbState.writes.filter((w) => w.status === 'complete' || w.status === 'failed')).toEqual(
      [],
    );
  });

  // `markBuildTerminalIfActive` has no internal try/catch, so a transient
  // Postgres throw on the exit-0 terminal write must NOT skip pokeScheduler() —
  // otherwise the row stays ACTIVE and pins the concurrency slot until the 75m
  // idle reaper even though the container exited and the deploy is live. Mirrors
  // enforceTimeout / cancelBuild: setStatus first, then try/finally(poke).
  it('still pokes the scheduler when the exit-0 terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    // The terminal write rejects (and surfaces), but the slot must already be
    // freed: pokeScheduler ran in the `finally` despite the rejection.
    await expect(m.onStop({ exitCode: 0, reason: 'exit' })).rejects.toThrow(
      'postgres write failed',
    );

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // Local DO status was set terminal BEFORE the failing write, so a later guard
    // won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
  });

  // failure branch: same decoupling for a non-zero exit — a Postgres throw
  // on the 'failed' terminal write must not strand the freed slot.
  it('still pokes the scheduler when the non-zero terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.onStop({ exitCode: 137, reason: 'runtime_signal' })).rejects.toThrow(
      'postgres write failed',
    );

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });

  // 3382011778: the exit-0 deployment lookup is BEST-EFFORT and runs AFTER
  // `void deploy` has already exited 0. A transient Hyperdrive/Postgres throw on
  // it must NOT strand the build — onStop must still finalize 'complete' (with a
  // null link) and poke the scheduler.
  //
  // FAIL-WITHOUT-FIX: the lookup used to run OUTSIDE the try/finally, so a
  // rejection propagated out of onStop BEFORE setStatus('complete'),
  // markBuildTerminalIfActive, and the finally poke — leaving the row ACTIVE and
  // the slot pinned until the 75m idle reaper while the deploy was already live.
  // All three assertions below (no reject, 'complete' write present, scheduler
  // poked) would fail without the fix.
  it('finalizes complete + pokes the scheduler when the exit-0 deployment lookup throws (3382011778)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];
    dbState.deployment = { id: 'dpl_123' };
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    // Lookup rejects once, AFTER the exit-0 (deploy already succeeded).
    vi.mocked(getDeploymentByProjectAndCommit).mockRejectedValueOnce(
      new Error('hyperdrive lookup failed'),
    );

    // Does NOT reject — the lookup error is swallowed.
    await m.onStop({ exitCode: 0, reason: 'exit' });

    // The build is still finalized 'complete', just without the deployment link.
    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.exitCode).toBe(0);
    expect(complete?.opts?.deploymentId).toBeNull();
    // Slot freed — the next queued build can start.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // Local DO status is terminal so a later guard won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
  });
});

describe('BuildManager.onError', () => {
  it('records failed with the error message', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.onError(new Error('boom'));

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('boom');
  });

  // 3382105553: onError's terminal write ran first, UNGUARDED — a transient
  // Postgres throw rejected onError before setStatus('failed') and pokeScheduler(),
  // leaving the row ACTIVE and the slot pinned until the 75m reaper. Mirror
  // onStop / enforceTimeout: local status first, DB write in a try whose finally
  // always pokes.
  //
  // FAIL-WITHOUT-FIX: the throw skipped both setStatus('failed') and
  // pokeScheduler() — the scheduler-poke and local-'failed' assertions fail.
  it('still pokes the scheduler + sets local failed when the onError terminal DB write throws (3382105553)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    // The terminal write rejects (and surfaces), but the slot must already be
    // freed: pokeScheduler ran in the finally despite the rejection.
    await expect(m.onError(new Error('boom'))).rejects.toThrow('postgres write failed');

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // Local DO status was set terminal BEFORE the failing write, so a later guard
    // won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });
});

// Lifecycle status-race regressions (the confirmed bug): the base `start()`
// runs onStart inside `blockConcurrencyWhile` BEFORE resolving, and a
// fast-exiting container's onStop can fire too. The DB row must never be
// resurrected to `starting`/`building` after a terminal outcome, and a duplicate
// terminal write must never clobber the first. The authoritative guard is the
// compare-and-set in db.ts (markBuildBuildingIfStarting / markBuildTerminalIfActive),
// not the in-memory `config.status` early-returns (which only see the DO copy).
describe('BuildManager lifecycle status-race CAS guards', () => {
  it('a fast-exit onStop right after startBuild lands a terminal row that is never reset to starting', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // The DB row is `starting` (scheduler claim). startBuild no longer writes
    // status, so a fast-exit onStop fires immediately after start().
    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });

    // The terminal outcome stands in the DB — there is no later `starting`
    // write in startBuild that could downgrade it (the bug). The row ends
    // `complete`, and `starting` was never (re)written by startBuild.
    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes.some((w) => w.status === 'starting')).toBe(false);
    expect(lastWrite('complete')).toBeDefined();
  });

  it('onStart does NOT resurrect a row a fast-exit onStop already drove terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Simulate the fast-exit onStop having already finalized the DB row, then a
    // delayed second onStart firing. The in-memory config still says active
    // ('building' from the startBuild onStart), so the in-memory guard would NOT
    // catch this — only the DB-level CAS does.
    dbState.status.set('b1', 'failed');
    dbState.writes = [];

    await m.onStart();

    // markBuildBuildingIfStarting is a no-op: the row stays terminal, no write.
    expect(dbState.status.get('b1')).toBe('failed');
    expect(dbState.writes).toEqual([]);
  });

  it('a duplicate/late terminal write does not clobber the first terminal outcome', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // First terminal outcome: a clean exit → complete, linked to a deployment.
    dbState.deployment = { id: 'dpl_first' };
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(dbState.status.get('b1')).toBe('complete');
    dbState.writes = [];

    // A duplicate/late onStop arrives with a different (failure) outcome. The
    // in-memory guard catches the obvious replay; force-prove the DB CAS too by
    // calling the terminal helper directly with the row already terminal.
    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });
    const { markBuildTerminalIfActive } = await import('../../src/db.ts');
    const moved = await markBuildTerminalIfActive(
      {} as unknown as Parameters<typeof markBuildTerminalIfActive>[0],
      'b1',
      'failed',
      { exitCode: 137 },
    );

    // No clobber: the row is still `complete`, the CAS returned false, and no new
    // terminal write was recorded.
    expect(moved).toBe(false);
    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes).toEqual([]);
  });
});

describe('BuildManager timeout integration (base-owned alarm + scheduled enforceTimeout)', () => {
  it('does NOT override alarm() — the base Container owns the DO alarm loop', () => {
    // Regression: a manager-level alarm() override would treat every base
    // monitor tick as a timeout (failing healthy builds) AND starve the base
    // loop that dispatches onStop. The manager must inherit the base alarm.
    const proto = Object.getPrototypeOf(BuildManager.prototype) as Record<string, unknown>;
    expect(Object.hasOwn(BuildManager.prototype, 'alarm')).toBe(false);
    // The inherited alarm is the base one (defined on the parent prototype).
    expect(typeof proto.alarm).toBe('function');
  });

  it('a base alarm BEFORE the deadline does not fail a healthy build, and onStop still finalizes', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    // Base alarm fires for its own monitor cadence (no schedule is due yet).
    // It must NOT touch build state — the build stays active. After startBuild the
    // status is 'building' (onStart ran inside the base start(), as in production).
    await m.alarm();
    expect(containerCalls.baseAlarms).toBe(1);
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });

    // The base lifecycle still finalizes the build via onStop on a clean exit.
    dbState.deployment = { id: 'dpl_ok' };
    await m.onStop({ exitCode: 0, reason: 'exit' });
    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.deploymentId).toBe('dpl_ok');
    // No timeout failure was recorded.
    expect(dbState.writes.some((w) => w.opts?.error === 'build timed out')).toBe(false);
  });

  it('crossing the deadline fails the build, stops the container, and frees the slot', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    // The base alarm loop invokes the scheduled enforceTimeout callback when due.
    await runDueSchedules(m);

    expect(containerCalls.stopped).toBe(1);
    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toMatch(/timed out/);
    // Slot freed: scheduler poked so the next queued build can start.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('force-kills the container via destroy() (SIGKILL) on timeout, not just stop() (SIGTERM)', async () => {
    // The real base `stop()` only SIGTERMs; a build whose PID-1 agent ignores
    // SIGTERM (or a wedged install child) survives it and pins a global fleet
    // slot forever, since the STALE reaper only re-cancels rows still ACTIVE and
    // this row is already terminal. enforceTimeout must escalate to destroy()
    // (SIGKILL). Discriminator: drop the destroy() in forceStopContainer and
    // `destroyed` stays 0.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await runDueSchedules(m);

    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('enforceTimeout is a no-op once the build is already terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });
    dbState.writes = [];
    containerCalls.stopped = 0;

    await m.enforceTimeout();

    expect(containerCalls.stopped).toBe(0);
    expect(dbState.writes).toEqual([]);
  });

  it('stops the container AND pokes the scheduler even when the terminal DB write throws', async () => {
    // `markBuildTerminalIfActive` has no internal try/catch: a Hyperdrive/Postgres
    // throw must NOT skip container teardown (a timed-out container would keep
    // running with a still-honored deploy token) or the scheduler poke (the freed
    // slot would be stranded). The local setStatus + stop() + poke are decoupled
    // from the DB write.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    // The timeout fires; the DB write rejects (and the error surfaces so the
    // caller can react), but enforceTimeout must have already torn down + poked
    // BEFORE the write — the rejection does not skip them.
    await expect(runDueSchedules(m)).rejects.toThrow('postgres write failed');

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // The local DO status is terminal so a subsequent onStop won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });
});

// cancelBuild RPC: the trusted DO→DO / API→DO cancel path the API (github.ts)
// invokes when a project is disconnected or its branch/executor changes,
// orphaning this build. No agent secret is required (unlike POST /cancel) — the
// stub container's startBuild stored the row `starting`, so the CAS engages.
describe('BuildManager.cancelBuild (internal RPC)', () => {
  it('stops the container, records cancelled via the CAS, and pokes the scheduler', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    // Called WITHOUT any agent header — the RPC path is trusted, like startBuild.
    await m.cancelBuild('project disconnected');

    expect(containerCalls.stopped).toBe(1);
    const cancelled = lastWrite('cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled?.id).toBe('b1');
    expect(cancelled?.opts?.error).toBe('project disconnected');
    // The CAS landed the terminal row.
    expect(dbState.status.get('b1')).toBe('cancelled');
    // Scheduler poked so the freed concurrency slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('force-kills the container via destroy() (SIGKILL) on cancel, not just stop() (SIGTERM)', async () => {
    // Same escalation as the timeout path: an orphaned build whose agent ignores
    // SIGTERM must still be SIGKILLed so the freed slot is genuinely reclaimed.
    // Discriminator: drop the destroy() in forceStopContainer and `destroyed`
    // stays 0.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await m.cancelBuild('project disconnected');

    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('defaults the reason to "build cancelled" when none is given', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.cancelBuild();

    expect(lastWrite('cancelled')?.opts?.error).toBe('build cancelled');
  });

  it('is a no-op (no clobber) once the build is already terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // First finalize the build cleanly.
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(dbState.status.get('b1')).toBe('complete');
    dbState.writes = [];
    containerCalls.stopped = 0;

    // A late cancel (project disconnected after the build already completed)
    // must NOT overwrite the recorded outcome — the CAS + in-memory guard hold.
    await m.cancelBuild('project disconnected');

    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes.some((w) => w.status === 'cancelled')).toBe(false);
    // stop() is still best-effort safe to call, but no terminal write occurs.
    expect(dbState.writes).toEqual([]);
  });

  it('stops the container AND pokes the scheduler even when the terminal DB write throws', async () => {
    // Same decoupling invariant as enforceTimeout: a Hyperdrive throw on the
    // terminal write must NOT skip container teardown (orphaned container) or the
    // scheduler poke (stranded slot). The local setStatus + stop() + poke run
    // independent of the DB write.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    // The DB write rejects (and surfaces), but stop() + poke already ran before
    // it — the rejection does not skip container teardown or the slot release.
    await expect(m.cancelBuild('project disconnected')).rejects.toThrow('postgres write failed');

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // The local DO status is terminal so a subsequent onStop won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
  });
});

describe('BuildManager log ingest + WebSocket replay', () => {
  it('appends ingested log lines to SQLite and replays them on WS upgrade', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Seed via ingestLines (the pull-loop sink) — the sole producer now that the
    // DO no longer accepts a POST /logs ingest.
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'build done', stream: 'stdout', ts: 2 } as unknown as LogRow,
    ]);
    expect(ctx._logs).toHaveLength(2);

    // WS upgrade → replays stored logs then a caught_up marker.
    const upgrade = await m.fetch(
      new Request('https://manager/', { headers: { Upgrade: 'websocket' } }),
    );
    expect(upgrade.status).toBe(101);
    const server = ctx._sockets[0];
    expect(server).toBeDefined();
    const messages = server.sent.map((s) => JSON.parse(s));
    expect(messages[0]).toMatchObject({ type: 'log', line: 'installing deps' });
    expect(messages[1]).toMatchObject({ type: 'log', line: 'build done' });
    expect(messages[2]).toEqual({ type: 'caught_up' });
  });

  it('caps stored logs at MAX_STORED_LOG_LINES so storage + replay stay bounded', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Push MORE than the cap; the oldest must be evicted and the table bounded.
    const total = MAX_STORED_LOG_LINES + 250;
    const batch: Array<{ line: string; stream: string; ts: number }> = [];
    for (let i = 1; i <= total; i++) {
      batch.push({ line: `line ${i}`, stream: 'stdout', ts: i });
    }
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines(
      batch as unknown as Array<LogRow>,
    );

    // Table is bounded to the cap, retaining the NEWEST lines (tail), dropping the
    // oldest (head). Pre-fix it held all `total` rows.
    expect(ctx._logs.length).toBe(MAX_STORED_LOG_LINES);
    expect(ctx._logs.some((r) => r.line === `line ${total}`)).toBe(true);
    expect(ctx._logs.some((r) => r.line === 'line 1')).toBe(false);

    // WS replay loads the bounded table (not an unbounded set).
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    const logMsgs = server.sent.map((s) => JSON.parse(s)).filter((msg) => msg.type === 'log');
    expect(logMsgs.length).toBe(MAX_STORED_LOG_LINES);
  });

  it('broadcasts new log lines to attached sockets', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Attach a socket first (no prior logs to replay).
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = []; // drop the caught_up marker

    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'live line', stream: 'stderr', ts: 3 } as unknown as LogRow,
    ]);

    const live = server.sent.map((s) => JSON.parse(s));
    expect(live.some((msg) => msg.type === 'log' && msg.line === 'live line')).toBe(true);
  });

  it('POST /status updates status and broadcasts', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(lastWrite('deploying')).toBeDefined();
  });

  it('POST /cancel stops the container and records cancelled', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(agentRequest(ctx, 'https://manager/cancel', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(containerCalls.stopped).toBe(1);
    expect(lastWrite('cancelled')).toBeDefined();
  });
});

// The admin worker (which holds the DO binding) polls the DO's stored logs over a
// plain, unauthenticated `GET /logs?since=N`. It is READ-ONLY: no inserts, no
// status writes, no broadcast — it just reads the SQLite `logs` table and returns
// JSON `{ lines: Array<{seq,line,stream,ts}>, lastSeq }` (rows with seq > N, asc).
// It must COEXIST with the WS upgrade (which branches first on the `Upgrade`
// header). Logs reach the store via the pull-loop sink (`ingestLines`); there is
// no longer a POST /logs ingest path.
describe('BuildManager.fetch GET /logs?since=N (admin poll read)', () => {
  /** Seed a batch of lines through the pull-loop sink (`ingestLines`). */
  async function seedLogs(
    _ctx: ReturnType<typeof makeStubCtx>,
    m: BuildManager,
    lines: Array<{ line: string; stream: string; ts: number }>,
  ): Promise<void> {
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines(
      lines as unknown as Array<LogRow>,
    );
  }

  it('since=0 returns all stored rows (seq+line+stream+ts) and the max seq as lastSeq', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [
      { line: 'installing deps', stream: 'stdout', ts: 10 },
      { line: 'build done', stream: 'stdout', ts: 20 },
    ]);

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
    };
    expect(body.lines).toEqual([
      { seq: 1, line: 'installing deps', stream: 'stdout', ts: 10 },
      { seq: 2, line: 'build done', stream: 'stdout', ts: 20 },
    ]);
    expect(body.lastSeq).toBe(2);
  });

  it('since=K returns ONLY rows with seq > K (asc), with lastSeq = max seq', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [
      { line: 'a', stream: 'stdout', ts: 1 },
      { line: 'b', stream: 'stdout', ts: 2 },
      { line: 'c', stream: 'stderr', ts: 3 },
    ]);

    const res = await m.fetch(new Request('https://manager/logs?since=1', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
    };
    // seq 1 ('a') is excluded; only seq > 1 returned.
    expect(body.lines).toEqual([
      { seq: 2, line: 'b', stream: 'stdout', ts: 2 },
      { seq: 3, line: 'c', stream: 'stderr', ts: 3 },
    ]);
    expect(body.lastSeq).toBe(3);
  });

  it('empty table returns { lines: [], lastSeq: <since> } (cursor held at the request)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // No logs ingested. since=0 → empty list, lastSeq echoes the requested 0.
    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body.lines).toEqual([]);
    expect(body.lastSeq).toBe(0);

    // A non-zero cursor against an empty table echoes that cursor (never moves back).
    const res2 = await m.fetch(new Request('https://manager/logs?since=7', { method: 'GET' }));
    const body2 = (await res2.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body2.lines).toEqual([]);
    expect(body2.lastSeq).toBe(7);
  });

  it('treats a missing/NaN since as 0 (returns everything)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [{ line: 'only', stream: 'stdout', ts: 1 }]);

    // No `since` param at all → defaults to 0.
    const missing = await m.fetch(new Request('https://manager/logs', { method: 'GET' }));
    const missingBody = (await missing.json()) as {
      lines: Array<{ seq: number }>;
      lastSeq: number;
    };
    expect(missingBody.lines.map((r) => r.seq)).toEqual([1]);
    expect(missingBody.lastSeq).toBe(1);

    // A non-numeric `since` → NaN → defaults to 0.
    const nan = await m.fetch(new Request('https://manager/logs?since=abc', { method: 'GET' }));
    const nanBody = (await nan.json()) as { lines: Array<{ seq: number }>; lastSeq: number };
    expect(nanBody.lines.map((r) => r.seq)).toEqual([1]);
    expect(nanBody.lastSeq).toBe(1);
  });

  it('is READ-ONLY: no status write, no new rows, no broadcast to attached sockets', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await seedLogs(ctx, m, [{ line: 'x', stream: 'stdout', ts: 1 }]);

    // Attach a socket and drop the replayed history so any GET-triggered send shows.
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];
    dbState.writes = [];
    const rowsBefore = ctx._logs.length;

    await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));

    expect(ctx._logs.length).toBe(rowsBefore); // no inserts
    expect(dbState.writes).toEqual([]); // no status writes
    expect(server.sent).toEqual([]); // no broadcast
  });

  it('surfaces the DO-local status + terminal from config (non-terminal while running)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // Pin a deterministic non-terminal status (startBuild → onStart may flip
    // 'starting' → 'building'); the point is terminal:false while running.
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('building');

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as { status: string | null; terminal: boolean };
    expect(body.status).toBe('building');
    expect(body.terminal).toBe(false);
  });

  it('surfaces terminal:true once the DO config reaches a terminal status (DO-authoritative)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Drive the DO-local status terminal (mirrors a completion path's setStatus).
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('complete');

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as { status: string | null; terminal: boolean };
    expect(body.status).toBe('complete');
    expect(body.terminal).toBe(true);
  });

  it('returns status:null, terminal:false when no build config exists yet', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    // No startBuild → no stored config.

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as { status: string | null; terminal: boolean };
    expect(body.status).toBeNull();
    expect(body.terminal).toBe(false);
  });

  it('does NOT collide with the WS upgrade: a GET WITHOUT the Upgrade header reads logs', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await seedLogs(ctx, m, [{ line: 'log', stream: 'stdout', ts: 1 }]);

    // GET /logs (no Upgrade) → JSON read (status 200), NOT a 101 upgrade.
    const read = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(read.status).toBe(200);
    expect(ctx._sockets.length).toBe(0); // no socket accepted

    // The WS path still works: a GET WITH the Upgrade header upgrades (101).
    const upgrade = await m.fetch(
      new Request('https://manager/logs', { headers: { Upgrade: 'websocket' } }),
    );
    expect(upgrade.status).toBe(101);
    expect(ctx._sockets.length).toBe(1);
  });
});

// The DO pulls build-log lines from the in-container agent (`GET /logs?since=N`)
// over the NON-starting raw port fetch (`container.getTcpPort(port).fetch(url)`),
// ingests them into the SQLite `logs` table + WS fan-out, advances an in-memory
// cursor, and re-arms itself via the base scheduler — the same
// `schedule(seconds, 'method')` mechanism `enforceTimeout` uses. The non-starting
// port fetch (NOT the auto-starting `containerFetch`) means a poll racing a
// just-exited container can never resurrect it. The stub's `container` getter routes
// `getTcpPort(port).fetch(url)` to a settable `_portFetch`, so each test stubs it.
describe('BuildManager.pollLogs (DO log pull-loop)', () => {
  /**
   * Stub the non-starting port fetch (`container.getTcpPort(port).fetch(url)`) on the
   * manager to return canned `GET /logs` responses. Backed by the stub's `_portFetch`,
   * invoked as `(url, port)` so the existing `(url, port)` assertions still hold.
   */
  function stubPortFetch(
    m: BuildManager,
    responses: Array<{ lines: Array<LogRow>; lastSeq: number } | Error>,
  ): ReturnType<typeof vi.fn> {
    let call = 0;
    const fn = vi.fn(async (_url: string, _port?: number) => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) {
        throw next;
      }
      return new RealResponse(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fn })._portFetch = fn;
    return fn;
  }

  /** Read the in-memory log cursor the loop advances. */
  function logCursor(m: BuildManager): number {
    return (m as unknown as { logCursor: number }).logCursor;
  }

  it('pulls two batches: ingests lines, advances the cursor, and re-arms', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Attach a socket so the broadcast side of ingest is observable; drop replay.
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];

    // Drive pollLogs directly across two batches (not via runDueSchedules — that
    // would also fire the 600s enforceTimeout armed at startBuild). Clear the
    // schedule first so each re-arm is observed in isolation.
    const fetchFn = stubPortFetch(m, [
      {
        lines: [
          { seq: 1, line: 'installing deps', stream: 'stdout', ts: 1 },
          { seq: 2, line: 'compiling', stream: 'stdout', ts: 2 },
        ],
        lastSeq: 2,
      },
      {
        lines: [{ seq: 3, line: 'uploading', stream: 'stdout', ts: 3 }],
        lastSeq: 3,
      },
    ]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    // First poll: requests with the initial cursor (0) on port 4000.
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(fetchFn.mock.calls[0][1]).toBe(4000);

    // Lines ingested into SQLite (seq stripped before insert) + broadcast over WS.
    expect(ctx._logs.map((r) => r.line)).toEqual(['installing deps', 'compiling']);
    const broadcast = server.sent.map((s) => JSON.parse(s));
    expect(broadcast.some((m) => m.type === 'log' && m.line === 'installing deps')).toBe(true);
    expect(broadcast.some((m) => m.type === 'log' && m.line === 'compiling')).toBe(true);

    // Cursor advanced to lastSeq; the loop re-armed itself.
    expect(logCursor(m)).toBe(2);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);

    // Second poll continues from the advanced cursor (since=2).
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=2');
    expect(ctx._logs.map((r) => r.line)).toEqual(['installing deps', 'compiling', 'uploading']);
    expect(logCursor(m)).toBe(3);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
  });

  it('returns without rescheduling when the build status is terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    // Drive the build terminal (mirrors a completed container).
    dbState.status.set('b1', 'building');
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });

    // Clear the schedule armed at startBuild so we observe ONLY pollLogs' decision.
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    // Self-terminated: no agent poll, no re-arm.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('does not pull (clean early-out) once the container has exited, even if status is not yet terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    // The container exited between polls but onStop hasn't run yet, so the
    // persisted status is still `building` (non-terminal). The running guard must
    // skip the fetch entirely and end the loop (onStop finalizes the build).
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;

    // Clear the schedule armed at startBuild so we observe ONLY pollLogs' decision.
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    // No port fetch and no re-arm — the loop stopped so onStop can finalize the build.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('swallows a port-fetch throw (no unhandled throw) and re-arms', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [new Error('container mid-start')]);

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    // Must not throw out of pollLogs even though the port fetch rejects.
    await expect(
      (m as unknown as { pollLogs: () => Promise<void> }).pollLogs(),
    ).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Nothing ingested; the loop still re-armed (the container may come up next tick).
    expect(ctx._logs).toHaveLength(0);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
  });

  it('uses the non-starting port fetch (never the auto-starting containerFetch) so a poll cannot resurrect the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig()); // running=true, status building

    // Spy on the auto-starting containerFetch — it must NEVER be called by pollLogs.
    const autoStart = vi.fn(async () => new RealResponse('{}', { status: 200 }));
    (m as unknown as { containerFetch: typeof autoStart }).containerFetch = autoStart;

    const portFetch = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(portFetch).toHaveBeenCalledTimes(1); // pulled via the non-starting path
    expect(autoStart).not.toHaveBeenCalled(); // never the auto-starting path
  });

  it('arms the first pollLogs tick in startBuild (after the CAS to building)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Both the timeout AND the log poll loop are armed via the base scheduler.
    expect(scheduledTasks(m)).toContainEqual({ whenSeconds: 1, callback: 'pollLogs' });
    expect(scheduledTasks(m).some((t) => t.callback === 'enforceTimeout')).toBe(true);
  });
});

describe('BuildManager.ingestLines (the pull-loop sink)', () => {
  it('inserts each line into SQLite and broadcasts it (sole producer is pollLogs)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];

    // Call ingestLines directly with BuildLogLine shape (no seq).
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'a', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'b', stream: 'stderr', ts: 2 } as unknown as LogRow,
    ]);

    expect(ctx._logs.map((r) => r.line)).toEqual(['a', 'b']);
    const sent = server.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: 'log', line: 'a', stream: 'stdout', ts: 1 });
    expect(sent).toContainEqual({ type: 'log', line: 'b', stream: 'stderr', ts: 2 });
  });
});

// Six backticks: the MINIMUM fence — survives log lines that themselves
// contain ``` (build tools echo markdown). Content with runs of ≥6 backticks
// grows the fence past the longest run (see the fence-sizing tests below).
const SIX_BACKTICKS = '``````';

// GitHub validates output.text in UTF-8 BYTES ("maximum bytesize of 65535"),
// so the byte-cap tests below measure results the way GitHub does.
const utf8 = new TextEncoder();

// Manual `String.prototype.isWellFormed()` (typing it needs lib es2024, which
// this package's tsconfig doesn't enable): true when the string contains an
// UNPAIRED surrogate — a high (0xD800–0xDBFF) not followed by a low
// (0xDC00–0xDFFF), or a low not preceded by a high. A byte-truncation cut that
// splits an emoji pair leaves exactly such a lone half.
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++; // complete pair — skip its low half
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Longest run of consecutive backticks in a string (0 when none).
function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
}

// Fence delimiters are dynamic (max(6, longest content run + 1)) — parse them
// from the rendered output instead of assuming six, and assert the format
// contract on the way: `<backticks>text` opener, matching bare-backtick closer
// as the final line.
function parseFence(out: string): { fenceLen: number; content: Array<string> } {
  const rendered = out.split('\n');
  const openIdx = rendered.findIndex((line) => /^`+text$/.test(line));
  expect(openIdx).toBeGreaterThan(-1);
  const fenceLen = rendered[openIdx].length - 'text'.length;
  expect(rendered[rendered.length - 1]).toBe('`'.repeat(fenceLen));
  return { fenceLen, content: rendered.slice(openIdx + 1, rendered.length - 1) };
}

describe('formatLogTailMarkdown (pure check-run output.text renderer)', () => {
  it('returns null when nothing was captured (PATCH omits text)', () => {
    expect(formatLogTailMarkdown([], 0)).toBe(null);
  });

  it('renders header + six-backtick text fence, lines in given order, no marker when all captured lines are shown', () => {
    expect(formatLogTailMarkdown(['a', 'b', 'c'], 3)).toBe(
      `**Last 3 log lines:**\n\n${SIX_BACKTICKS}text\na\nb\nc\n${SIX_BACKTICKS}`,
    );
  });

  it('adds the omission marker when more lines were captured than are rendered', () => {
    expect(formatLogTailMarkdown(['b', 'c'], 5)).toBe(
      `**Last 2 log lines:**\n\n_…earlier lines omitted._\n\n${SIX_BACKTICKS}text\nb\nc\n${SIX_BACKTICKS}`,
    );
  });

  it('drops the OLDEST lines until the joined content fits the char cap (result under GitHub 65535)', () => {
    // 100 lines of exactly 1000 chars: joined = 100*1000 + 99 separators > 60000.
    // Kept-count k satisfies 1000k + (k-1) <= 60000 → k = 59 (59058 chars).
    const lines = Array.from(
      { length: 100 },
      (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(996)}`,
    );
    const out = formatLogTailMarkdown(lines, 100);
    expect(out).not.toBe(null);
    expect(out).toContain('**Last 59 log lines:**');
    expect(out).toContain('_…earlier lines omitted._');
    // The newest survives; the newest DROPPED line (index 40) does not.
    expect(out).toContain(lines[99]);
    expect(out).toContain(lines[41]);
    expect(out).not.toContain(lines[40]);
    expect((out as string).length).toBeLessThan(65535);
  });

  it('keeps the LAST 60000 chars of a single over-cap line', () => {
    const big = 'h'.repeat(5000) + 't'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    expect(formatLogTailMarkdown([big], 1)).toBe(
      `**Last 1 log lines:**\n\n${SIX_BACKTICKS}text\n${'t'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES)}\n${SIX_BACKTICKS}`,
    );
    // Exactly AT the cap is kept whole — the cap only drops what EXCEEDS it.
    const atCap = 'e'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    expect(formatLogTailMarkdown([atCap], 1)).toContain(`\n${atCap}\n`);
  });

  it('grows the fence to 7 backticks when a content line contains a 6-backtick run (no breakout)', () => {
    const line = `fence bait: ${SIX_BACKTICKS} tail`;
    const out = formatLogTailMarkdown([line], 1) as string;
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBe(7);
    // The line is preserved verbatim — sizing the fence, not mangling content.
    expect(content).toEqual([line]);
    // General invariant: no content backtick run can reach the fence length.
    expect(Math.max(...content.map(longestBacktickRun))).toBeLessThan(fenceLen);
  });

  it('grows the fence to 13 backticks for a 12-backtick content run', () => {
    const out = formatLogTailMarkdown(['a', `x${'`'.repeat(12)}y`, 'b'], 3) as string;
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBe(13);
    expect(content).toEqual(['a', `x${'`'.repeat(12)}y`, 'b']);
  });

  it('keeps the fence at exactly six backticks when the content has no backticks', () => {
    const { fenceLen } = parseFence(formatLogTailMarkdown(['plain', 'lines'], 2) as string);
    expect(fenceLen).toBe(6);
  });

  it('holds the WHOLE string under GitHub’s 65535 cap for a pathological all-backtick line', () => {
    const out = formatLogTailMarkdown(['`'.repeat(61000)], 1) as string;
    expect(out.length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    // Format still parses: header first, then fence lines matching
    // ^`+text$ / ^`+$, and the fence still beats every content run.
    expect(out.split('\n')[0]).toBe('**Last 1 log lines:**');
    const { fenceLen, content } = parseFence(out);
    expect(content.length).toBeGreaterThan(0);
    expect(fenceLen).toBeGreaterThan(Math.max(...content.map(longestBacktickRun)));
  });

  // ——— UTF-8 byte caps: GitHub validates output.text in BYTES, not UTF-16
  // code units (its 422 reads "maximum bytesize of 65535"). CJK is 3 bytes
  // per code unit and emoji 4 bytes per 2 units, so unit-measured caps let
  // such content sail past GitHub's real limit. ———

  it('drops oldest lines by UTF-8 BYTE measure, not code units (CJK content)', () => {
    // 40 lines of 4 ASCII + 998 CJK chars: 1002 units / 2998 bytes each.
    // Joined: 40119 units (fits a 60000 UNIT cap — the wrong measure) but
    // 119959 bytes. The byte cap keeps k lines where 2998k + (k-1) <= 60000,
    // i.e. the newest 20.
    const lines = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(4, '0')}${'语'.repeat(998)}`,
    );
    const out = formatLogTailMarkdown(lines, 40) as string;
    expect(out).toContain('**Last 20 log lines:**');
    expect(out).toContain('_…earlier lines omitted._');
    expect(out).toContain(lines[39]);
    expect(out).toContain(lines[20]);
    expect(out).not.toContain(lines[19]);
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
  });

  it('tail-truncates a lone CJK line to its LAST ~60000 UTF-8 bytes (under 65535 total)', () => {
    // 30000 units (would fit a unit cap untouched) but 90000 bytes.
    const out = formatLogTailMarkdown(['好'.repeat(30000)], 1) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    const { content } = parseFence(out);
    expect(content).toHaveLength(1);
    // Still a pure '好' tail, and NEAR the 60000-byte content cap — proves
    // byte-capping keeps the tail rather than over-truncating it.
    expect(/^好+$/.test(content[0])).toBe(true);
    const contentBytes = utf8.encode(content[0]).length;
    expect(contentBytes).toBeLessThanOrEqual(60000);
    expect(contentBytes).toBeGreaterThanOrEqual(59990);
  });

  it('never leaves a split surrogate pair at a truncation cut (emoji at the boundary)', () => {
    // '🚀' = 2 UTF-16 units / 4 UTF-8 bytes: 20000 emoji = 80000 bytes, so the
    // byte cap must cut inside the emoji run. A cut landing mid-pair would
    // strand a lone surrogate (re-encoded as a 3-byte U+FFFD — garbage).
    const out = formatLogTailMarkdown(['🚀'.repeat(20000)], 1) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('converges the WHOLE string under 65535 BYTES when the dynamic fence eats the byte headroom (emoji + backtick run)', () => {
    // Content: 13500 emoji (54000 bytes) + a 6000-backtick run = 60000 bytes
    // exactly — passes the content cap untouched. The 6001-backtick fence
    // delimiters then push the rendered BYTE length past 65535 while its
    // UTF-16 length stays far under (the unit measure never fires). The
    // converging loop must cut the lone line by bytes without splitting an
    // emoji pair.
    const out = formatLogTailMarkdown(['🚀'.repeat(13500) + '`'.repeat(6000)], 1) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    expect(hasLoneSurrogate(out)).toBe(false);
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBeGreaterThan(Math.max(...content.map(longestBacktickRun)));
  });
});

describe('BuildManager finalizeCheckRun log tail (output.text)', () => {
  // These assert on the ACTUAL completion PATCH body: the file-level check-run
  // mock is routed to the REAL completeCheckRun (importActual) and the global
  // fetch is stubbed to capture the PATCH. `getInstallationToken` stays
  // file-mocked, so the real module runs fully offline.
  let patches: Array<{ url: string; body: { output: Record<string, unknown> } }>;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../../src/github/check-run.ts')>(
      '../../src/github/check-run.ts',
    );
    vi.mocked(completeCheckRun).mockImplementation(actual.completeCheckRun);
    patches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'PATCH' && /\/check-runs\/[^/]+$/.test(url)) {
          patches.push({ url, body: JSON.parse(String(init?.body)) });
          return new Response('{}', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore the file-level inert default so the other suites keep a no-op mock.
    vi.mocked(completeCheckRun).mockImplementation(async () => false);
  });

  it('embeds the stored log tail as output.text in the completion PATCH', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // Finalize resolves the run id from DO storage (create is inert in this file).
    ctx._kv.set('checkRunId', '99001');
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'building app', stream: 'stdout', ts: 2 } as unknown as LogRow,
      { line: 'deploy complete', stream: 'stdout', ts: 3 } as unknown as LogRow,
    ]);

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(patches[0].body.output.text).toBe(
      `**Last 3 log lines:**\n\n${SIX_BACKTICKS}text\ninstalling deps\nbuilding app\ndeploy complete\n${SIX_BACKTICKS}`,
    );
  });

  it('omits output.text entirely when no log lines were captured', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    // The PATCH body is byte-identical to the pre-tail contract: no `text` key.
    expect('text' in patches[0].body.output).toBe(false);
  });

  it('still PATCHes (without text) when the log-tail read throws (best-effort)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(
      m as unknown as { readLogTailMarkdown: () => string | null },
      'readLogTailMarkdown',
    ).mockImplementation(() => {
      throw new Error('sqlite read failed');
    });

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect('text' in patches[0].body.output).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'finalizeCheckRun: log tail read failed (best-effort)',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

describe('BuildManager agent-control auth + transition guards', () => {
  it('rejects POST /status without the agent secret (401) and leaves status unchanged', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      new Request('https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(401);
    // No status write occurred, so the stored state was not touched. (onStart ran
    // inside the base start() at startBuild, so the status sits at 'building'; the
    // rejected control POST must leave it there.)
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });

  it('rejects POST /cancel without the agent secret (401) and does not stop the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const res = await m.fetch(new Request('https://manager/cancel', { method: 'POST' }));

    expect(res.status).toBe(401);
    expect(containerCalls.stopped).toBe(0);
  });

  it('rejects POST /status with a WRONG agent secret (401)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      new Request('https://manager/status', {
        method: 'POST',
        headers: { Authorization: 'Bearer not-the-real-token' },
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(dbState.writes).toEqual([]);
  });

  it('rejects a terminal status from the agent even WITH the secret (4xx) and keeps status unchanged', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    for (const status of ['complete', 'failed', 'cancelled'] as const) {
      const res = await m.fetch(
        agentRequest(ctx, 'https://manager/status', {
          method: 'POST',
          body: JSON.stringify({ status }),
        }),
      );
      expect(res.status).toBe(400);
    }

    // No terminal write — the build was NOT finalized by the agent. (status sits
    // at 'building' from onStart inside the base start(); a rejected agent
    // terminal write must not move it.)
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });

  it('accepts a non-terminal status WITH the secret', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(lastWrite('deploying')).toBeDefined();
  });

  // A progress report that races a concurrent terminalizer must NOT
  // resurrect the cancelled row. The DO's local status can still say active
  // (its setStatus didn't run for the out-of-band cancel), so the only thing
  // standing between a forged/late 'deploying' and a re-enabled deploy token is
  // the guarded CAS — which must no-op against the already-`cancelled` DB row.
  it('POST /status on an out-of-band cancelled row → 409, row stays cancelled, no write, container stopped', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Simulate a concurrent terminalizer (push-supersede / disconnect) that
    // committed the DB row `cancelled` while the DO's LOCAL config.status still
    // says active ('building', from onStart inside the base start()).
    dbState.status.set('b1', 'cancelled');
    dbState.writes = [];
    containerCalls.stopped = 0;

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(409);
    // The CAS no-op'd → no 'deploying' write, row stays cancelled.
    expect(dbState.writes.some((w) => w.status === 'deploying')).toBe(false);
    expect(dbState.status.get('b1')).toBe('cancelled');
    // cancelBuild best-effort stop()s the orphaned container.
    expect(containerCalls.stopped).toBe(1);
  });

  // The agent param is whitelisted to progress statuses only, so a
  // buggy/malicious agent can't write an arbitrary lifecycle state (e.g.
  // resetting a row to 'queued').
  it('rejects a non-whitelist status (queued) WITH the secret (400) and writes nothing', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'queued' }),
      }),
    );

    expect(res.status).toBe(400);
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });
});

// Env scrub: the build agent must NOT hand the control-plane secrets to
// untrusted repo child processes (install / `void deploy`), or a malicious
// postinstall could read DO_LOG_URL/AGENT_TOKEN and forge build status.
describe('build-agent sanitizeChildEnv (env scrub)', () => {
  const fullEnv = {
    PATH: '/usr/bin',
    HOME: '/root',
    DO_LOG_URL: 'https://manager/logs',
    SOURCE_TOKEN: 'ghs_secret',
    AGENT_TOKEN: 'agent-secret',
    VOID_TOKEN: 'deploy-jwt',
    CF_ACCESS_CLIENT_ID: 'svc-id.access',
    CF_ACCESS_CLIENT_SECRET: 'svc-secret',
    VOID_API_URL: 'https://api.void.cloud',
    VOID_PROJECT: 'my-app',
  };

  it('drops every control-plane + credential secret from the (install) child env', () => {
    const child = sanitizeChildEnv(fullEnv);
    expect(child.DO_LOG_URL).toBeUndefined();
    expect(child.SOURCE_TOKEN).toBeUndefined();
    expect(child.AGENT_TOKEN).toBeUndefined();
    // the live deploy token must NOT reach untrusted install lifecycle
    // scripts — a postinstall could exfiltrate it or publish to the scoped
    // project within the TTL. It's scrubbed by default; only the deploy step
    // re-injects it (see the next test).
    expect(child.VOID_TOKEN).toBeUndefined();
    // The shared staging CF Access service token is equally sensitive — a leaked
    // pair reaches every Access-gated staging host — so it's scrubbed too.
    expect(child.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(child.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
    // The scrub list is exactly these secrets.
    expect([...SCRUBBED_ENV_VARS].sort()).toEqual([
      'AGENT_TOKEN',
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'DO_LOG_URL',
      'SOURCE_TOKEN',
      'VOID_TOKEN',
    ]);
  });

  it('re-injects VOID_TOKEN + CF Access creds only for the trusted deploy step (via extra overrides)', () => {
    // The deploy spawn passes the captured deploy token + CF Access pair as extra
    // (runBuild captures them into locals and deletes them from process.env before
    // any child spawns — see the parent-process scrub tests below).
    const deployEnv = sanitizeChildEnv(fullEnv, {
      VOID_TOKEN: fullEnv.VOID_TOKEN,
      CF_ACCESS_CLIENT_ID: fullEnv.CF_ACCESS_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: fullEnv.CF_ACCESS_CLIENT_SECRET,
    });
    expect(deployEnv.VOID_TOKEN).toBe('deploy-jwt');
    expect(deployEnv.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
    expect(deployEnv.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
    // Still scrubbed of the DO control-plane secrets.
    expect(deployEnv.DO_LOG_URL).toBeUndefined();
    expect(deployEnv.SOURCE_TOKEN).toBeUndefined();
    expect(deployEnv.AGENT_TOKEN).toBeUndefined();
  });

  it('drops re-inject overrides whose value is undefined (off-staging CF Access)', () => {
    // On production/dev the captured CF Access locals are undefined; passing them
    // as extra must not resurrect an empty/garbage value — sanitizeChildEnv treats
    // an undefined override as a delete.
    const deployEnv = sanitizeChildEnv(fullEnv, {
      VOID_TOKEN: fullEnv.VOID_TOKEN,
      CF_ACCESS_CLIENT_ID: undefined,
      CF_ACCESS_CLIENT_SECRET: undefined,
    });
    expect(deployEnv.VOID_TOKEN).toBe('deploy-jwt');
    expect(deployEnv.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(deployEnv.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
  });

  it('keeps non-secret deploy + system vars the build legitimately needs', () => {
    const child = sanitizeChildEnv(fullEnv);
    expect(child.VOID_API_URL).toBe('https://api.void.cloud');
    expect(child.VOID_PROJECT).toBe('my-app');
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/root');
  });

  it('does not mutate the source env object', () => {
    const copy = { ...fullEnv };
    sanitizeChildEnv(fullEnv);
    expect(fullEnv).toEqual(copy);
  });
});

// Parent-process secret scrub (heap env). The agent deletes the control-plane +
// credential secrets from its OWN `process.env` at the right lifecycle points —
// AGENT_TOKEN/DO_LOG_URL at module load (captured into module consts first), and
// SOURCE_TOKEN/VOID_TOKEN inside runBuild (captured into locals, deleted before
// any child spawns). This is defense-in-depth for the spawn-inheritance path
// only: `sanitizeChildEnv` already strips the COPY handed to every untrusted
// child. It does NOT scrub `/proc/self/environ` — `unsetenv()` only mutates the
// heap `environ`, while `/proc/<pid>/environ` keeps the initial-stack block — so
// a same-uid child running as root can still recover these via
// `/proc/<ppid>/environ` (closing that needs a non-root uid for untrusted
// children, a tracked follow-up). The deploy-child→vite-build VOID_TOKEN
// inheritance is the deferred CLI-trust-split item, out of scope here.
describe('build-agent shutdown handlers (PID-1 SIGTERM delivery)', () => {
  it('registers SIGTERM + SIGINT listeners so the DO stop() SIGTERM is not dropped by PID 1', () => {
    // The agent is PID 1 in the container; Linux delivers a signal to PID 1 only
    // if a handler is installed, else it is dropped. Without these listeners the
    // DO's stop() (a bare SIGTERM) is silently ignored and the container leaks a
    // global slot. Assert the listeners are registered; clean up only the ones we
    // added (diff against the pre-existing set so we don't disturb the runner's).
    const beforeTerm = process.rawListeners('SIGTERM');
    const beforeInt = process.rawListeners('SIGINT');
    try {
      installShutdownHandlers();
      const addedTerm = process.rawListeners('SIGTERM').filter((l) => !beforeTerm.includes(l));
      const addedInt = process.rawListeners('SIGINT').filter((l) => !beforeInt.includes(l));
      expect(addedTerm).toHaveLength(1);
      expect(addedInt).toHaveLength(1);
    } finally {
      for (const l of process.rawListeners('SIGTERM').filter((x) => !beforeTerm.includes(x))) {
        process.removeListener('SIGTERM', l as (...args: Array<unknown>) => void);
      }
      for (const l of process.rawListeners('SIGINT').filter((x) => !beforeInt.includes(x))) {
        process.removeListener('SIGINT', l as (...args: Array<unknown>) => void);
      }
    }
  });
});

describe('build-agent parent-process secret scrub', () => {
  it('deletes AGENT_TOKEN and DO_LOG_URL from process.env at module load', async () => {
    // Both are captured into module-level consts (read by postToDo) at import,
    // then deleted from process.env at load — BEFORE any child spawns. Prove the
    // delete by re-importing the module fresh with both set: the load-time delete
    // must remove them from the parent's heap env. (Pre-fix the module left them
    // in process.env, so this would still see them after import.)
    const saved = { AGENT_TOKEN: process.env.AGENT_TOKEN, DO_LOG_URL: process.env.DO_LOG_URL };
    process.env.AGENT_TOKEN = 'agent-secret';
    process.env.DO_LOG_URL = 'https://manager/logs';
    try {
      vi.resetModules();
      // Re-evaluate the agent module so its load-time scrub runs against the env
      // we just set. The import is for its side effect (the deletes).
      await import('../../container/build-agent.mjs');
      expect(process.env.AGENT_TOKEN).toBeUndefined();
      expect(process.env.DO_LOG_URL).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    }
  });

  it('deletes VOID_TOKEN and SOURCE_TOKEN from process.env during runBuild — while the deploy child still receives VOID_TOKEN', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);

      // After runBuild, the parent's HEAP env no longer holds either secret (the
      // spawn-inheritance vector is closed; the `/proc/self/environ` block is
      // NOT scrubbed — see this describe's preamble).
      expect(process.env.VOID_TOKEN).toBeUndefined();
      expect(process.env.SOURCE_TOKEN).toBeUndefined();

      // The install child saw neither (sanitizeChildEnv scrubs the copy AND the
      // parent already deleted them).
      const install = seen.find((s) => s.cmd === 'npm');
      expect(install?.env?.VOID_TOKEN).toBeUndefined();
      expect(install?.env?.SOURCE_TOKEN).toBeUndefined();

      // The trusted deploy child STILL receives the token (captured into a local
      // before the parent-env delete and re-injected via the extra overrides).
      const deploy = seen.find((s) => s.cmd === 'npx');
      expect(deploy?.env?.VOID_TOKEN).toBe('deploy-jwt');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

// Untrusted build children must run as a NON-ROOT uid. `delete
// process.env.X` cannot scrub `/proc/<ppid>/environ` (unsetenv leaves the
// initial-stack env block), so a same-uid child of the root agent could recover
// AGENT_TOKEN/SOURCE_TOKEN regardless. The fix drops the install + deploy children
// to BUILDER_UID, hands them a writable cache HOME, and chowns the root-extracted
// source tree to the builder. Real setuid only works as root (in the container),
// so the unit seam asserts the pure helpers + the wiring, not a live uid drop.
describe('build-agent non-root child isolation', () => {
  it('childSpawnOptions drops untrusted children to the non-root builder uid/gid', () => {
    const opts = childSpawnOptions();
    expect(opts.uid).toBe(BUILDER_UID);
    expect(opts.gid).toBe(BUILDER_GID);
    expect(BUILDER_UID).toBe(1000);
    expect(BUILDER_GID).toBe(1000);
    // Non-zero (non-root) is the security invariant — co-locating with the root
    // agent's uid is the bug this closes.
    expect(opts.uid).toBeGreaterThan(0);
    expect(opts.cwd).toBe('/tmp/build/src');
  });

  it('builderCacheEnv points every package-manager cache at the builder home', () => {
    // Without these the non-root builder would EPERM writing corepack/npm/yarn/bun
    // caches — the image defaults e.g. BUN_INSTALL=/usr/local (root-owned).
    const env = builderCacheEnv();
    expect(env.HOME).toBe(BUILDER_HOME);
    expect(env.HOME).toBe('/home/builder');
    expect(env.XDG_CACHE_HOME).toBe('/home/builder/.cache');
    expect(env.npm_config_cache).toBe('/home/builder/.npm');
    expect(env.COREPACK_HOME).toBe('/home/builder/.cache/node/corepack');
    expect(env.YARN_CACHE_FOLDER).toBe('/home/builder/.cache/yarn');
    expect(env.BUN_INSTALL).toBe('/home/builder/.bun');
  });

  it('the install AND deploy children run with the builder cache env (HOME=/home/builder)', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);

      const install = seen.find((s) => s.cmd === 'npm');
      expect(install?.env?.HOME).toBe('/home/builder');
      expect(install?.env?.COREPACK_HOME).toBe('/home/builder/.cache/node/corepack');
      expect(install?.env?.BUN_INSTALL).toBe('/home/builder/.bun');

      const deploy = seen.find((s) => s.cmd === 'npx');
      expect(deploy?.env?.HOME).toBe('/home/builder');
      // The builder cache env must NOT clobber the re-injected deploy token.
      expect(deploy?.env?.VOID_TOKEN).toBe('deploy-jwt');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('hands the extracted tree to the builder (chown) after download, before the install child', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const order: Array<string> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {
          order.push('download');
        }),
        chownWorkDir: vi.fn(async () => {
          order.push('chown');
        }),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(async (cmd: string) => {
          order.push(`child:${cmd}`);
          return 0;
        }),
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);
      // chown must sit between the source download and the first untrusted child,
      // so the root-extracted tree is builder-owned before non-root install writes.
      expect(order[0]).toBe('download');
      expect(order[1]).toBe('chown');
      expect(order.indexOf('chown')).toBeLessThan(order.indexOf('child:npm'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  // a dependency lifecycle script that daemonizes during install survives as
  // a same-uid sibling of the deploy child and could read its
  // /proc/<deploy-pid>/environ (VOID_TOKEN + staging CF Access). runBuild must
  // reap all BUILDER_UID processes AFTER the install child closes and BEFORE the
  // deploy child spawns.
  it('reaps leftover builder processes between install and the deploy spawn', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const order: Array<string> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        chownWorkDir: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        // install is cmd 'npm', deploy is cmd 'npx'
        runChild: vi.fn(async (cmd: string) => {
          order.push(`child:${cmd}`);
          return 0;
        }),
        killBuilderProcesses: vi.fn(async () => {
          order.push('reap');
        }),
        reportStatus: vi.fn(async (status: string) => {
          order.push(`status:${status}`);
        }),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);
      // The reap runs strictly after the install child closes and strictly before
      // the deploy child (and even before the 'deploying' status flip).
      expect(order.indexOf('child:npm')).toBeLessThan(order.indexOf('reap'));
      expect(order.indexOf('reap')).toBeLessThan(order.indexOf('status:deploying'));
      expect(order.indexOf('reap')).toBeLessThan(order.indexOf('child:npx'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('does NOT reap (or deploy) when the install fails', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const reap = vi.fn(async () => {});
      const runChild = vi.fn(async () => 19); // install fails
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        chownWorkDir: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        killBuilderProcesses: reap,
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(19);
      // A failed install returns before the deploy phase, so there is no
      // secret-bearing deploy child to protect — the reap is skipped.
      expect(reap).not.toHaveBeenCalled();
      expect(runChild).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('parseProcStatusUid', () => {
  it('parses the real uid from the Uid line', () => {
    const status =
      'Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n';
    expect(parseProcStatusUid(status)).toBe(1000);
  });

  it('parses a root (uid 0) process', () => {
    expect(parseProcStatusUid('Name:\tagent\nUid:\t0\t0\t0\t0\n')).toBe(0);
  });

  it('returns null when there is no Uid line (kernel-thread / torn read)', () => {
    expect(parseProcStatusUid('Name:\tkworker\nState:\tI (idle)\n')).toBeNull();
  });
});

// lifecycle invariant: the build agent must ALWAYS resolve to an exit code
// and close its control server on every failure path, so the container never
// hangs on a still-open listening socket (which would leak a build slot until
// the DO's `sleepAfter` ceiling — or indefinitely for unlimited plans with no
// timeout alarm). Previously a non-zero install exit `return`ed out of the
// driver, bypassing `process.exit` and `server.close`.
describe('build-agent lifecycle (container must always exit)', () => {
  const REQUIRED_ENV = ['VOID_TOKEN', 'VOID_API_URL', 'VOID_PROJECT'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('resolves to the non-zero install exit code (no hang) when install fails', async () => {
    // runChild returns the package-manager exit code; a non-zero install must
    // resolve runBuild to that code WITHOUT running the deploy step or dropping
    // out of the driver unresolved.
    const deploy = vi.fn(async () => 0);
    const runChild = vi.fn(async (cmd: string) => {
      // first invocation is the dependency install — fail it.
      return cmd === 'npx' ? await deploy() : 17;
    });

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });

    expect(code).toBe(17);
    // The deploy step must NOT run after a failed install.
    expect(deploy).not.toHaveBeenCalled();
    // Exactly one child ran (the install); deploy was skipped.
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it('passes VOID_TOKEN to the DEPLOY child but NOT the INSTALL child', async () => {
    // Capture the env each spawned child receives. runChild is called first for
    // the install (cmd !== 'npx'), then for the deploy (cmd === 'npx').
    const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
    const runChild = vi.fn(
      async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
        seen.push({ cmd, env: opts?.env });
        return 0;
      },
    );

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);

    const install = seen.find((s) => s.cmd === 'npm');
    const deploy = seen.find((s) => s.cmd === 'npx');
    expect(install).toBeDefined();
    expect(deploy).toBeDefined();
    // The untrusted install (postinstall scripts) must NOT see the deploy token.
    expect(install?.env?.VOID_TOKEN).toBeUndefined();
    // The trusted deploy step still authenticates with it.
    expect(deploy?.env?.VOID_TOKEN).toBe('deploy-jwt');
  });

  it('falls back to the PINNED void@<version> (never @latest) when the repo has no local void', async () => {
    // BuildManager injects VOID_CLI_VERSION; the agent must spawn that exact
    // pinned version, never a moving `void@latest` dist-tag.
    const savedCliVersion = process.env.VOID_CLI_VERSION;
    process.env.VOID_CLI_VERSION = '0.9.1';
    try {
      const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
      const runChild = vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      });

      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        reportStatus: vi.fn(async () => {}),
        // No local `void` binary → take the npx fallback path.
        hasLocalVoid: () => false,
      });
      expect(code).toBe(0);

      const deploy = seen.find((s) => s.cmd === 'npx');
      expect(deploy).toBeDefined();
      expect(deploy?.args).toContain('void@0.9.1');
      expect(deploy?.args.some((a) => a === 'void@latest')).toBe(false);
    } finally {
      if (savedCliVersion === undefined) {
        delete process.env.VOID_CLI_VERSION;
      } else {
        process.env.VOID_CLI_VERSION = savedCliVersion;
      }
    }
  });

  it('resolves to the deploy exit code on a successful install + failed deploy', async () => {
    const runChild = vi.fn(async (cmd: string) => (cmd === 'npx' ? 1 : 0));
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(1);
  });

  it('resolves to 0 on a fully successful build', async () => {
    const runChild = vi.fn(async () => 0);
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);
  });

  it('resolves to non-zero (1) when a build step throws — never leaves the driver unresolved', async () => {
    const code = await runBuild({
      downloadSource: vi.fn(async () => {
        throw new Error('source download failed: HTTP 404');
      }),
    });
    expect(code).toBe(1);
  });

  it('closeControlServer invokes server.close and resolves (server-close path on every exit)', async () => {
    let closed = false;
    const fakeServer = {
      close(cb: () => void) {
        closed = true;
        cb();
      },
    };
    await expect(closeControlServer(fakeServer)).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it('closeControlServer is a no-op for a null server (best-effort)', async () => {
    await expect(closeControlServer(null)).resolves.toBeUndefined();
    await expect(closeControlServer(undefined)).resolves.toBeUndefined();
  });
});

// the build agent's REAL package-manager + deploy-command
// resolution reads the repo files in WORK_DIR (`/tmp/build/src`). These tests
// prepare that directory on disk, run `runBuild` WITHOUT injecting
// `resolveInstall` (so the real lockfile/packageManager detection runs), and
// capture the spawned commands via an injected `runChild`. The WORK_DIR is wiped
// before/after each case so a stray `.pnp.cjs`/lockfile can't leak into another
// test's deploy-command branch (which keys off `existsSync('.pnp.cjs')`).
describe('build-agent install + deploy resolution', () => {
  const WORK_DIR = '/tmp/build/src';
  const REQUIRED_ENV = ['VOID_TOKEN', 'VOID_API_URL', 'VOID_PROJECT'] as const;
  let savedEnv: Record<string, string | undefined>;

  function resetWorkDir(): void {
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
  }

  /** Run the real install + deploy resolution, capturing every spawned command. */
  async function runAndCapture(
    hasLocalVoid: () => boolean,
  ): Promise<Array<{ cmd: string; args: ReadonlyArray<string> }>> {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      // resolveInstall is intentionally NOT injected — exercise the real one.
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid,
    });
    expect(code).toBe(0);
    return seen;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    resetWorkDir();
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  // a yarn.lock repo pinned to Yarn CLASSIC (1.x via Corepack) must install
  // with `--frozen-lockfile` — Yarn 1 does NOT recognize Berry's `--immutable`
  // and would SILENTLY run a mutable install, losing the frozen-lockfile guard.
  it('yarn.lock + packageManager yarn@1.x → install with --frozen-lockfile', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@1.22.19' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  // a yarn.lock repo pinned to Yarn Berry (4.x) installs with `--immutable`.
  it('yarn.lock + packageManager yarn@4.x → install with --immutable', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
  });

  // NO packageManager pin — the flag is sniffed from the yarn.lock header.
  // Corepack's REAL unpinned default is Yarn 1.22 (Classic), and a v1 lockfile
  // carries a `# yarn lockfile v1` header → must install `--frozen-lockfile`
  // (Yarn 1 silently ignores Berry's `--immutable` → mutable install). Without
  // the header sniff this regressed to `--immutable`, the original bug.
  it('yarn.lock (v1 header) + NO pin → install with --frozen-lockfile', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n',
    );
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  // a Berry lockfile (no v1 header, `__metadata` block) with no pin AND no
  // `.yarnrc.yml` yarnPath has no resolvable Yarn version — corepack's default
  // Classic 1.22 ignores `--immutable` and can't parse a Berry lock. resolveInstall
  // FAILS FAST with actionable guidance rather than breaking mid-install.
  it('yarn.lock (Berry __metadata) + NO pin + no yarnrc → fails fast, no install spawned', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n',
    );
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(1);
    expect(seen.some((s) => s.cmd === 'corepack' && s.args[0] === 'yarn')).toBe(false);
  });

  // a Berry lockfile with no pin but a `.yarnrc.yml` yarnPath WORKS: corepack's
  // default Yarn 1.22 re-execs the bundled Berry release, which honors `--immutable`.
  it('yarn.lock (Berry __metadata) + NO pin + .yarnrc.yml yarnPath → install with --immutable', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n',
    );
    writeFileSync(`${WORK_DIR}/.yarnrc.yml`, 'yarnPath: .yarn/releases/yarn-4.3.1.cjs\n');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
  });

  // NO lockfile but a packageManager pin must be honored — defaulting to
  // `npm install` would break a pnpm `workspace:*` repo / install a different
  // graph. No lockfile means no frozen flag.
  it('no lockfile + packageManager pnpm@9 → corepack pnpm install (no frozen flag)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'pnpm@9.1.0' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'pnpm');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['pnpm', 'install']);
    // No npm fallback was used.
    expect(seen.some((s) => s.cmd === 'npm')).toBe(false);
  });

  it('no lockfile + packageManager yarn@4 → corepack yarn install (no frozen flag)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install']);
  });

  it('no lockfile + NO packageManager pin → npm install (default preserved)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'npm');
    expect(install?.args).toEqual(['install']);
  });

  // a Yarn Berry PnP repo (`.pnp.cjs` present, no node_modules) must run the
  // deploy THROUGH the package manager so PnP is active and the build children
  // `void deploy` spawns inherit it — `corepack yarn ... deploy`, NOT bare npx.
  it('PnP repo (.pnp.cjs present) runs deploy via corepack yarn, not bare npx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    // void resolves in the PnP graph → `yarn void deploy`.
    const seen = await runAndCapture(() => true);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy).toBeDefined();
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    // The deploy did NOT go through bare npx.
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  it('PnP repo without resolvable void falls back to yarn dlx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    // void does NOT resolve → `yarn dlx void@<ver> deploy`.
    const seen = await runAndCapture(() => false);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args.slice(0, 2)).toEqual(['yarn', 'dlx']);
    expect(deploy?.args.some((a) => a.startsWith('void@'))).toBe(true);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // The default `hasLocalVoid` must NOT treat a present `.pnp.cjs` as proof
  // that `void` is locally resolvable — under PnP (no `node_modules/.bin/void`)
  // it checks whether the repo DECLARES `void`. A PnP repo that declares void →
  // `yarn void deploy`; one that does not → the `yarn dlx void@<ver>` fetch
  // fallback. Previously the default always reported local under PnP, so the dlx
  // fallback was dead and a PnP repo without a `void` dep wrongly ran `yarn void`.
  it('default hasLocalVoid: PnP repo that DECLARES void → corepack yarn void deploy', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(
      `${WORK_DIR}/package.json`,
      JSON.stringify({ packageManager: 'yarn@4.3.1', dependencies: { void: '^0.9.0' } }),
    );

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      // hasLocalVoid intentionally NOT injected — exercise the real default.
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  it('default hasLocalVoid: PnP repo that does NOT declare void → corepack yarn dlx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      // hasLocalVoid intentionally NOT injected — the real default must FETCH
      // because the repo does not declare `void`.
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args.slice(0, 2)).toEqual(['yarn', 'dlx']);
    expect(deploy?.args.some((a) => a.startsWith('void@'))).toBe(true);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // 3382105547: `pnpPresent` must be computed AFTER download() populates WORK_DIR.
  // It used to be an eager `const` at runBuild entry, but download() runs INSIDE
  // runBuild, so for real builds WORK_DIR was empty when it ran → pnpPresent was
  // always false → every PnP repo silently took the bare-`npx` path (which can't
  // resolve PnP-managed deps during `void deploy`). The PnP tests above
  // pre-wrote `.pnp.cjs` BEFORE runBuild, which masked the ordering — here the
  // `.pnp.cjs` appears only when download() runs, exactly like a real container.
  //
  // FAIL-WITHOUT-FIX: with the eager const, pnpPresent is false at entry, so the
  // deploy spawns as bare `npx void deploy` and both the `corepack` and no-`npx`
  // assertions below fail.
  it('detects PnP created by download() (not pre-existing) → corepack yarn (3382105547)', async () => {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      // WORK_DIR starts clean (beforeEach); the source — including `.pnp.cjs` —
      // only materializes once download() runs, like a real build.
      downloadSource: vi.fn(async () => {
        writeFileSync(`${WORK_DIR}/yarn.lock`, '');
        writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
        writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
      }),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.args.includes('deploy'));
    expect(deploy?.cmd).toBe('corepack');
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // 3435922052: `pnpPresent` must be computed AFTER the install step, not just
  // after download(). A Yarn Berry PnP repo can gitignore `.pnp.cjs` and let
  // `yarn install` GENERATE it — a snapshot taken before install reads false, so
  // the deploy wrongly takes the bare-`npx` path (no node_modules, no active PnP
  // runtime → the build children `void deploy` spawns can't resolve deps). Here
  // `.pnp.cjs` appears only when the install command runs.
  //
  // FAIL-WITHOUT-FIX: pnpPresent snapshotted before install is false → deploy is
  // bare `npx void deploy` → the corepack + no-`npx` assertions below fail.
  it('detects PnP created by yarn install (not committed) → corepack yarn (3435922052)', async () => {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {
        // Berry repo that does NOT commit `.pnp.cjs` — only yarn.lock + pin.
        writeFileSync(`${WORK_DIR}/yarn.lock`, '');
        writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
      }),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        // `yarn install` generates the PnP loader (the case committed `.pnp.cjs`
        // tests above don't cover).
        if (cmd === 'corepack' && args[0] === 'yarn' && args[1] === 'install') {
          writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
        }
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.args.includes('deploy'));
    expect(deploy?.cmd).toBe('corepack');
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });
});

// 3382226043: `record()` appended every line to `logBuffer` with no eviction, so
// a verbose build (large package-manager / compiler output) could OOM the agent
// on the memory-constrained standard-1 container and fail an otherwise-valid
// build. The buffer is now capped at MAX_BUFFERED_LOG_LINES (oldest evicted in a
// chunk), keeping only a best-effort recent tail for the /logs pull.
describe('build-agent log buffer is bounded (3382226043)', () => {
  // FAIL-WITHOUT-FIX: without eviction, `logBuffer.length` grows to the total
  // number of recorded lines (>> the cap), so the length assertion fails.
  it('caps logBuffer at MAX_BUFFERED_LOG_LINES while keeping the most recent line', () => {
    const flood = MAX_BUFFERED_LOG_LINES * 2 + 137;
    for (let i = 0; i < flood; i += 1) {
      record(`line ${i}`, 'stdout');
    }
    const buf = getBufferedLogLines();
    // Bounded regardless of how much was logged (or what prior tests recorded —
    // the cap is absolute).
    expect(buf.length).toBeLessThanOrEqual(MAX_BUFFERED_LOG_LINES);
    // The newest line is always retained...
    expect(buf.at(-1)?.line).toBe(`line ${flood - 1}`);
    // ...the oldest were evicted (seq stays monotonic, so the first retained seq
    // is far past 1)...
    expect(buf[0].seq).toBeGreaterThan(1);
    // ...and seq is contiguous across the retained window (no gaps from eviction).
    expect(buf.at(-1)!.seq - buf[0].seq + 1).toBe(buf.length);
  });

  // record() also mirrors every line to process.stderr (the last-resort log path).
  // Capping logBuffer + pendingLines isn't enough: process.stderr.write ALSO queues
  // in Node's Writable buffer when the sink drains slowly, so a flood with a slow/
  // blocked log consumer would grow THAT buffer without bound — the same OOM in the
  // stream layer. record() now latches on write()'s false return and skips the
  // mirror until 'drain'.
  it('stops mirroring to stderr under backpressure instead of buffering per line', () => {
    // Clear any saturation latched by a prior test (fires the registered once-
    // 'drain' if set; a no-op otherwise), so this test starts unsaturated.
    process.stderr.emit('drain');
    // Simulate a permanently-full sink: write() always reports saturation.
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(false);
    try {
      const flood = 5000;
      for (let i = 0; i < flood; i += 1) {
        record(`line ${i}`, 'stdout');
      }
      // FAIL-WITHOUT-FIX: without the latch, write() is called once per line
      // (== flood). With it, the first false latches saturation and the rest skip,
      // so the call count is tiny and independent of flood size.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
      // Release the latch for subsequent tests (fires the once-'drain' set above).
      process.stderr.emit('drain');
    }
  });
});

// pipeStream turns a child's byte stream into line-delimited record() calls. Two
// verified bugs: (1) it split only on `\n`, so `\r` progress frames (install /
// build spinners that rewrite a line with bare CR) produced ZERO log lines until
// the process exited — live tail showed nothing during the build. (2) the
// partial-line buffer had no byte cap, so a `\n`-free run grew unbounded and the
// MAX_BUFFERED_LOG_LINES ring (a LINE-count cap, not a byte cap) never bounded it
// — able to OOM the standard-1 container. The fix splits on CR/LF/CRLF and, past
// MAX_PARTIAL_LINE_CHARS, records ONE truncated line then drops the rest of that
// line until its terminator (so a terminator-free flood = one bounded record).
// The CR for a torn CRLF is tracked in a flag, never buffered as data, so it is
// never emitted mid-line or at EOF.
describe('build-agent pipeStream line splitting + tail cap', () => {
  // Minimal stand-in for the child's stdout/stderr: pipeStream only uses
  // setEncoding (no-op here — we feed strings directly) plus the 'data'/'end'
  // events. Emitting synchronously lets each test assert right after feed().
  class FakeReadable extends EventEmitter {
    setEncoding() {}
    feed(...chunks: Array<string>) {
      for (const chunk of chunks) {
        this.emit('data', chunk);
      }
    }
    end() {
      this.emit('end');
    }
  }

  // Module log state (logBuffer/logSeq) is shared across tests and never reset,
  // so capture the lines recorded only after this point.
  function capture(run: (src: FakeReadable) => void): Array<string> {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    run(src);
    return getBufferedLogLines()
      .slice(before)
      .map((l) => l.line);
  }

  it('flushes bare-CR progress frames as lines instead of holding them until end', () => {
    // FAIL-WITHOUT-FIX: splitting only on `\n`, "a\rb\rc" carries the whole run
    // in `tail` and records nothing before 'end' — live tail stays empty.
    const src = new FakeReadable();
    const before = getBufferedLogLines().length;
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('a\rb\rc');
    // The completed frames are recorded on the data event, BEFORE end.
    expect(
      getBufferedLogLines()
        .slice(before)
        .map((l) => l.line),
    ).toEqual(['a', 'b']);
    src.end();
    // The final frame (no trailing terminator) flushes on end.
    expect(
      getBufferedLogLines()
        .slice(before)
        .map((l) => l.line),
    ).toEqual(['a', 'b', 'c']);
  });

  it('bounds a terminator-free flood to ONE truncated record (memory cap)', () => {
    // FAIL-WITHOUT-FIX: recording the full over-cap tail (and the line-count ring
    // not being a byte cap) lets a `\n`-free flood retain ~its entire size. The
    // fix records one truncated line, then drops the rest until a terminator.
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    // 12.8 MB of bytes with zero line terminators, fed as 64 KiB chunks.
    for (let i = 0; i < 200; i++) {
      src.feed('y'.repeat(64 * 1024));
    }
    src.end();
    const recorded = getBufferedLogLines().slice(before);
    // Exactly one record, capped at the per-line limit (+ marker), NOT ~12.8 MB.
    expect(recorded).toHaveLength(1);
    expect(recorded[0].line.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS + 32);
    expect(recorded[0].line.endsWith('truncated]')).toBe(true);
  });

  it('resumes normal recording after the dropped over-cap line hits a newline', () => {
    // The remainder of an over-cap line is dropped only until its terminator;
    // subsequent lines record normally (the drop does not swallow the stream).
    const lines = capture((src) => {
      src.feed('z'.repeat(MAX_PARTIAL_LINE_CHARS + 10), 'still-dropped\nafter\n');
      src.end();
    });
    // [0] = the truncated monster line; "still-dropped" is the monster's tail and
    // is discarded; "after" records normally.
    expect(lines).toHaveLength(2);
    expect(lines[0].endsWith('truncated]')).toBe(true);
    expect(lines[1]).toBe('after');
  });

  it('does not flush a carried CR as data at the force-flush boundary (torn CRLF)', () => {
    // FAIL-WITH-OLD-FIX: carrying the `\r` into `tail` let the force-flush emit a
    // line ending in `\r`, then the next chunk's `\n` opened a spurious empty
    // line. The CR is now a flag, never buffered, so neither happens.
    const lines = capture((src) => {
      src.feed('x'.repeat(MAX_PARTIAL_LINE_CHARS) + '\r', '\nZ');
      src.end();
    });
    expect(lines.some((l) => l.endsWith('\r'))).toBe(false);
    expect(lines.some((l) => l === '')).toBe(false);
    expect(lines.at(-1)).toBe('Z');
  });

  it('treats a stream ending on a bare CR as a delimiter, not trailing data', () => {
    // FAIL-WITH-OLD-FIX: end() recorded the carried `\r` as data ("a\r"). A CR is
    // a delimiter, so the line is "a".
    const lines = capture((src) => {
      src.feed('a\r');
      src.end();
    });
    expect(lines).toEqual(['a']);
  });

  it('does not emit empty lines for a CRLF split across a chunk boundary at the CR|LF seam', () => {
    // The trailing `\r` of the first chunk is held back so the next chunk's `\n`
    // completes the CRLF without producing a spurious empty record.
    const lines = capture((src) => {
      src.feed('x\r', '\ny\r\n');
      src.end();
    });
    expect(lines).toEqual(['x', 'y']);
  });

  it('preserves plain newline splitting (no behavior change for LF streams)', () => {
    const withTrailing = capture((src) => {
      src.feed('a\nb\nc\n');
      src.end();
    });
    expect(withTrailing).toEqual(['a', 'b', 'c']);

    const noTrailing = capture((src) => {
      src.feed('a\nb\nc');
      src.end();
    });
    expect(noTrailing).toEqual(['a', 'b', 'c']);
  });

  it('flushes a partial tail with no trailing newline on end', () => {
    const lines = capture((src) => {
      src.feed('partial-no-newline');
      src.end();
    });
    expect(lines).toEqual(['partial-no-newline']);
  });

  // A bare-CR flood (a runaway progress spinner, or a malicious build) emits one
  // record() per CR. The per-line byte cap can't help — each line is short; the
  // hazard is the COUNT of delimiter-emitted lines piling into the unflushed PUSH
  // batch within a single synchronous 'data' handler (the flush timer can't fire
  // until the handler yields). MAX_PENDING_LOG_LINES bounds the batch.
  it('bounds the pending PUSH batch under a bare-CR delimiter flood', () => {
    // One chunk, processed in a single synchronous turn (no flush can interleave),
    // carrying far more CR delimiters than the cap.
    const flood = MAX_PENDING_LOG_LINES * 3 + 11;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('\r'.repeat(flood));
    // FAIL-WITHOUT-FIX: without the cap, every CR pushes a row and the batch grows
    // to `flood` (>> the cap) before any flush — the OOM path Codex flagged.
    expect(getPendingLogLineCount()).toBeLessThanOrEqual(MAX_PENDING_LOG_LINES);
  });
});
