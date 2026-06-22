import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// DurableObject base class isn't available in unit tests — mock it like the
// other DO suites (cron-scheduler, usage-counter).
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Mock db.ts so the scheduler's queue/claim/concurrency logic runs against
// controllable fakes instead of Postgres. `tiers.ts` is left real — its pure
// functions encode the per-plan concurrency the scheduler must enforce.
type FakeBuild = {
  id: string;
  project_id: string;
  user_id: string;
  commit_sha: string | null;
  branch: string | null;
  // Which backend the row was queued for. The config-match guard compares
  // this against the connection's `build_executor`. Defaults to 'container' (the
  // only executor the scheduler drains).
  executor?: 'container' | 'github_actions';
  // Optional wall-clock age used by the fake getQueuedBuilds to model the real
  // helper's age-fair ordering. Larger = older. Defaults to insertion order.
  age?: number;
};

const db = {
  // `queued` models EVERY queued container build (what hasQueuedContainerBuilds
  // sees). `startable` models only the builds whose project is idle (what the
  // real getQueuedBuilds returns). When `startable` is null the two track
  // together (the common case); set it to [] to simulate a fully BLOCKED queue
  // — queued rows exist but none are startable.
  queued: [] as Array<FakeBuild>,
  startable: null as Array<FakeBuild> | null,
  users: new Map<string, { plan: string; login: string }>(),
  activeByUser: new Map<string, number>(),
  connections: new Map<
    string,
    {
      repo_full_name: string;
      installation_id: string;
      branch: string;
      build_executor?: 'container' | 'github_actions';
    } | null
  >(),
  projects: new Map<string, { slug: string } | null>(),
  // ids that should fail the atomic claim (simulate a lost race)
  unclaimable: new Set<string>(),
  // ids a concurrent terminalizer (push-supersede / branch-executor change /
  // disconnect / install removal) already drove terminal while startBuild was in
  // flight. The guarded `requeueBuildIfStarting` CAS no-ops on these, so they are
  // NOT requeued (the terminal status is preserved).
  terminalized: new Set<string>(),
  failed: [] as Array<{ id: string; error: string }>,
  // records every build driven to `cancelled` (e.g. the config-match guard:
  // a queued build whose branch/executor no longer matches the connection).
  cancelled: [] as Array<{ id: string; error: string }>,
  // records every build returned to `queued` via the guarded requeue CAS (the
  // capacity-shed retry path) so the suite can assert a fleet-full build is
  // requeued, not failed — and is NOT requeued when concurrently terminalized.
  requeued: [] as Array<string>,
  // records every claimBuildForStartWithinLimit call so the suite can assert the
  // scheduler now goes through the single atomic cap+claim primitive.
  claimArgs: [] as Array<{
    buildId: string;
    userId: string;
    projectId: string;
    limit: number;
  }>,
};

// The scheduler now enforces the per-user cap AND claims queued->starting in a
// SINGLE primitive (`claimBuildForStartWithinLimit`) that holds a per-user
// FOR UPDATE lock — the same lock the OIDC path takes — instead of a separate
// countUserActiveBuilds + claimBuildForStart pair. The fake reproduces the
// primitive's contract: false when at cap (limit > 0 && active >= limit) or
// when the build is unclaimable (lost the queued->starting race); true
// otherwise. limit === 0 means unlimited.
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  // Models the real helper: excludes builds owned by `excludeUserIds`, then
  // returns the rest oldest-first (age-fair) up to `limit`. When `db.startable`
  // is set it stands in for the per-idle-project filtering the real query does;
  // the exclude + age-order is still applied on top so the suite can assert the
  // scheduler passes capped owners through.
  getQueuedBuilds: vi.fn(
    async (_db: unknown, limit: number, excludeUserIds: ReadonlyArray<string> = []) => {
      const exclude = new Set(excludeUserIds);
      return (db.startable ?? db.queued)
        .filter((b) => !exclude.has(b.user_id))
        .slice()
        .sort((a, b) => (b.age ?? 0) - (a.age ?? 0))
        .slice(0, limit);
    },
  ),
  // For each user owning a queued build, report their plan + active count so the
  // scheduler can compute who is at their cap and exclude them from the scan.
  getUsersWithQueuedContainerBuilds: vi.fn(async (_db: unknown) => {
    const ownerIds = new Set(db.queued.map((b) => b.user_id));
    return Array.from(ownerIds).map((userId) => ({
      userId,
      plan: db.users.get(userId)?.plan ?? 'free',
      activeBuilds: db.activeByUser.get(userId) ?? 0,
    }));
  }),
  hasQueuedContainerBuilds: vi.fn(async (_db: unknown) => db.queued.length > 0),
  getUser: vi.fn(async (_db: unknown, id: string) => {
    const u = db.users.get(id);
    return u ? { id, plan: u.plan, login: u.login } : null;
  }),
  claimBuildForStartWithinLimit: vi.fn(
    async (
      _db: unknown,
      args: { buildId: string; userId: string; projectId: string; limit: number },
    ) => {
      db.claimArgs.push(args);
      const active = db.activeByUser.get(args.userId) ?? 0;
      if (args.limit > 0 && active >= args.limit) {
        return false;
      }
      if (db.unclaimable.has(args.buildId)) {
        return false;
      }
      return true;
    },
  ),
  getGitHubConnection: vi.fn(async (_db: unknown, projectId: string) => {
    return db.connections.get(projectId) ?? null;
  }),
  getProject: vi.fn(async (_db: unknown, id: string) => db.projects.get(id) ?? null),
  updateBuildStatus: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: { error?: string }) => {
      if (status === 'failed') {
        db.failed.push({ id, error: opts?.error ?? '' });
      }
      if (status === 'cancelled') {
        db.cancelled.push({ id, error: opts?.error ?? '' });
      }
    },
  ),
  // CAS terminal-if-active: apply the terminal status ONLY if the row is still
  // active. Models the real `UPDATE ... WHERE status IN (active)` guard — a row a
  // concurrent terminalizer already drove terminal (modelled by `db.terminalized`)
  // is a no-op (records nothing, returns false), so the RPC-fail catch can't
  // clobber a committed 'cancelled' to 'failed'. The scheduler uses this for the
  // transport-level startBuild-RPC failure path.
  markBuildTerminalIfActive: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: { error?: string }) => {
      if (db.terminalized.has(id)) {
        return false;
      }
      if (status === 'failed') {
        db.failed.push({ id, error: opts?.error ?? '' });
      }
      if (status === 'cancelled') {
        db.cancelled.push({ id, error: opts?.error ?? '' });
      }
      return true;
    },
  ),
  // Guarded CAS `starting -> queued`: the capacity-shed retry goes through this
  // instead of an unconditional updateBuildStatus('queued'). Models the real
  // `UPDATE ... WHERE status='starting'` guard — if a concurrent terminalizer
  // already drove the row terminal (modelled by `db.terminalized`), this no-ops
  // and returns false (the terminal status is preserved), so the build is NOT
  // requeued / resurrected.
  requeueBuildIfStarting: vi.fn(async (_db: unknown, id: string) => {
    if (db.terminalized.has(id)) {
      return false;
    }
    db.requeued.push(id);
    return true;
  }),
}));

import { BuildScheduler } from '../../src/build-scheduler.ts';
import {
  claimBuildForStartWithinLimit,
  getGitHubConnection,
  getQueuedBuilds,
  markBuildTerminalIfActive,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';

function makeStubCtx() {
  let alarmTime: number | null = null;
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: vi.fn(async (k: string) => store.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      getAlarm: vi.fn(async () => alarmTime),
      setAlarm: vi.fn(async (t: number) => {
        alarmTime = t;
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
    },
  };
}

function makeEnv(startBuild: ReturnType<typeof vi.fn>) {
  const stub = { startBuild };
  const idFromName = vi.fn((name: string) => ({ name }));
  const get = vi.fn(() => stub);
  return {
    HYPERDRIVE: { connectionString: 'postgres://fake' },
    BUILD_MANAGER: { idFromName, get },
  } as unknown as ApiEnv['Bindings'] & {
    BUILD_MANAGER: { idFromName: typeof idFromName; get: typeof get };
  };
}

function makeScheduler(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildScheduler(ctx as unknown as DurableObjectState, env);
}

function resetDb() {
  db.queued = [];
  db.startable = null;
  db.users = new Map();
  db.activeByUser = new Map();
  db.connections = new Map();
  db.projects = new Map();
  db.unclaimable = new Set();
  db.terminalized = new Set();
  db.failed = [];
  db.cancelled = [];
  db.requeued = [];
  db.claimArgs = [];
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
});

describe('BuildScheduler.fetch', () => {
  it('POST /poke arms a near-immediate alarm', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    const res = await s.fetch(new Request('https://scheduler/poke', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0] as number;
    // ~50ms ahead of the current clock.
    expect(armed).toBeGreaterThanOrEqual(now);
    expect(armed).toBeLessThanOrEqual(now + 1000);
  });

  it('GET /status returns the next alarm', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const res = await s.fetch(new Request('https://scheduler/status'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ nextAlarm: null });
  });

  it('unknown path 404s', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const res = await s.fetch(new Request('https://scheduler/nope'));
    expect(res.status).toBe(404);
  });
});

describe('BuildScheduler.alarm', () => {
  function enqueue(b: Partial<FakeBuild> & { id: string; user_id: string; project_id: string }) {
    const build: FakeBuild = {
      commit_sha: 'sha1',
      branch: 'main',
      ...b,
    };
    db.queued.push(build);
    if (!db.projects.has(build.project_id)) {
      db.projects.set(build.project_id, { slug: `slug-${build.project_id}` });
    }
    if (!db.connections.has(build.project_id)) {
      db.connections.set(build.project_id, {
        repo_full_name: 'owner/repo',
        installation_id: 'inst1',
        branch: 'main',
      });
    }
  }

  it('does not reschedule when the queue is empty', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    await s.alarm();
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('re-arms the alarm when the queue is fully blocked (nothing startable but queued work remains)', async () => {
    // getQueuedBuilds returns [] (every queued build's project already has an
    // active build, so none are startable) but hasQueuedContainerBuilds is true.
    // The alarm must NOT lapse — it has to keep its heartbeat so the blocked
    // build is picked up when its project frees, rather than relying on a
    // completion poke that can be lost.
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.startable = []; // nothing startable, but db.queued still has b1
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // No build started, but the alarm re-armed ~2s ahead.
    expect(startBuild).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0] as number;
    expect(armed).toBeGreaterThanOrEqual(now + 2000 - 500);
  });

  it('claims a startable build and invokes startBuild on the manager stub', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as unknown as {
      buildId: string;
      projectSlug: string;
      login: string;
      repoFullName: string;
      installationId: string;
      instanceType: string;
      timeoutMinutes: number;
    };
    expect(cfg.buildId).toBe('b1');
    expect(cfg.projectSlug).toBe('slug-p1');
    expect(cfg.login).toBe('octocat');
    expect(cfg.repoFullName).toBe('owner/repo');
    expect(cfg.installationId).toBe('inst1');
    // free plan → standard-1, 10 min
    expect(cfg.instanceType).toBe('standard-1');
    expect(cfg.timeoutMinutes).toBe(10);
    // BUILD_MANAGER keyed by build id.
    expect(
      (env as unknown as { BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn> } }).BUILD_MANAGER
        .idFromName,
    ).toHaveBeenCalledWith('b1');
    // the cap + claim went through the single atomic primitive holding the
    // per-user FOR UPDATE lock, with the plan's concurrency cap (free = 1).
    expect(claimBuildForStartWithinLimit).toHaveBeenCalledOnce();
    expect(db.claimArgs).toEqual([{ buildId: 'b1', userId: 'u1', projectId: 'p1', limit: 1 }]);
  });

  it('enforces per-user tier concurrency (free plan = 1)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.activeByUser.set('u1', 1); // already at the free-plan cap of 1
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // At cap → the owner is excluded from the scan UP FRONT, so the
    // capped build is never inspected (no claim attempt) and never started. The
    // alarm still re-arms because queued work remains, picked up once u1 frees a
    // slot. (Previously the build was inspected-then-skipped at claim time,
    // wasting a scan slot — the exclude avoids that.)
    expect(getQueuedBuilds).toHaveBeenCalledWith(expect.anything(), expect.any(Number), ['u1']);
    expect(db.claimArgs).toEqual([]);
    expect(startBuild).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  // the scheduler must start a build ONLY when the atomic cap+claim primitive
  // returns true; when it returns false (at cap OR lost the claim race) the build
  // is left for a later tick. This mirrors the OIDC path's per-user FOR UPDATE
  // lock so the container scan and a parallel OIDC exchange can't both create
  // active builds beyond the cap.
  it('starts only when claimBuildForStartWithinLimit returns true; leaves it otherwise', async () => {
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    // b1 will be claimed (under cap); b2 is forced unclaimable → primitive false.
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u1', project_id: 'p2' });
    db.unclaimable.add('b2');
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // Both builds went through the atomic primitive (FIFO scan preserved).
    expect(db.claimArgs).toEqual([
      { buildId: 'b1', userId: 'u1', projectId: 'p1', limit: 3 },
      { buildId: 'b2', userId: 'u1', projectId: 'p2', limit: 3 },
    ]);
    // Only the claimed build (b1) was started.
    expect(startBuild).toHaveBeenCalledOnce();
    expect((startBuild.mock.calls[0][0] as { buildId: string }).buildId).toBe('b1');
    // b2 was neither started nor failed — left queued for a later tick.
    expect(db.failed.some((f) => f.id === 'b2')).toBe(false);
  });

  it('allows pro plan to start up to 3 concurrent builds', async () => {
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    db.activeByUser.set('u1', 2); // pro cap is 3, so one more is allowed
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as unknown as { instanceType: string };
    expect(cfg.instanceType).toBe('standard-2');
  });

  it('skips a build whose atomic claim is lost (primitive returns false)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.unclaimable.add('b1');
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
  });

  it('fails a build with a missing user and continues', async () => {
    // no user registered for u-missing
    enqueue({ id: 'b1', user_id: 'u-missing', project_id: 'p1' });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.failed.some((f) => f.id === 'b1' && /user/.test(f.error))).toBe(true);
  });

  it('fails a build whose project has no github connection', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.connections.set('p1', null); // connection deleted between webhook and scan
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.failed.some((f) => f.id === 'b1' && /connection/.test(f.error))).toBe(true);
  });

  it('leaves a build queued (never claimed or failed) when a pre-claim lookup throws transiently', async () => {
    // Regression: getGitHubConnection / getProject run BEFORE the atomic
    // claim, so a transient DB/Hyperdrive throw must NOT claim the build. A claim
    // would flip it queued->starting (active) with no BuildManager yet created to
    // own the wall-clock timeout, and the stale reaper only covers github_actions
    // builds — so a container build would be stuck `starting` forever, blocking
    // its project and consuming the owner's slot. With the lookups first, the
    // throw aborts this tick with the build still `queued`; CF retries the alarm
    // and the next scan picks it up.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    vi.mocked(getGitHubConnection).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await expect(s.alarm()).rejects.toThrow('hyperdrive timeout');

    // Claim never reached -> the build is still `queued`, not stuck `starting`.
    expect(db.claimArgs).toHaveLength(0);
    expect(startBuild).not.toHaveBeenCalled();
    // A transient error must not terminalize the build (it is retried next tick).
    expect(db.failed).toHaveLength(0);
  });

  it('excludes a capped owner from the scan so an under-cap owner is not starved', async () => {
    // Regression: the per-user cap is enforced only at claim time, so if a
    // CAPPED owner held the rows the scan would surface first (lowest project_id
    // / oldest), every tick would inspect-then-skip those rows and never reach an
    // under-cap owner's later, claimable build. The scheduler must instead exclude
    // capped owners up front (computed in TS from the plan-derived cap) so the
    // scan window is spent only on startable work.
    //
    // u1 (free, cap 1) is AT cap and owns the OLDEST/lowest-project_id queued
    // build (b1, p1). u2 (free, cap 1) is under cap and owns a newer, later
    // project's build (b2, p2). Without the exclude, b1 would be scanned first and
    // b2 never reached this tick.
    db.users.set('u1', { plan: 'free', login: 'capped' });
    db.users.set('u2', { plan: 'free', login: 'eligible' });
    db.activeByUser.set('u1', 1); // u1 at the free-plan cap of 1
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', age: 2 }); // oldest, capped owner
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2', age: 1 }); // newer, eligible owner
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // The capped owner (u1) was excluded from the scan up front.
    expect(getQueuedBuilds).toHaveBeenCalledOnce();
    const [, , excludeUserIds] = vi.mocked(getQueuedBuilds).mock.calls[0];
    expect(excludeUserIds).toEqual(['u1']);

    // Only the eligible owner's build was claimed + started; the capped owner's
    // build was never even inspected (no claim attempt for b1).
    expect(db.claimArgs).toEqual([{ buildId: 'b2', userId: 'u2', projectId: 'p2', limit: 1 }]);
    expect(startBuild).toHaveBeenCalledOnce();
    expect((startBuild.mock.calls[0][0] as { buildId: string }).buildId).toBe('b2');
  });

  it('requeues a build (not failed) and backs off when startBuild throws the container-capacity error', async () => {
    // The global BuildManager fleet is at its max_instances cap, so
    // `@cloudflare/containers` throws its capacity error out of start(), which
    // BuildManager re-throws untouched. The scheduler must classify this as
    // transient platform pressure: return the row to `queued` (so a later alarm
    // retries it once an instance frees) rather than marking it permanently
    // failed. The requeue goes through the guarded `requeueBuildIfStarting` CAS
    // (starting -> queued only); the row is still `starting` here, so it requeues.
    // The heartbeat keeps the alarm armed while queued work remains — but at a
    // longer JITTERED backoff (>= CAPACITY_BACKOFF_BASE_MS = 20s) instead of the
    // normal 2s cadence, so we don't burn the GitHub compare + token mint
    // every 2s while the fleet is full. A completion poke re-arms sooner.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // Requeued via the guarded CAS, NOT failed.
    expect(db.requeued).toEqual(['b1']);
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
    // The build is still queued, so the alarm re-armed — but with the capacity
    // backoff (>= now + 20s), not the normal 2s cadence.
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0] as number;
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('breaks the scan on the first capacity error (does not drain the rest of the batch)', async () => {
    // startBuild does the GitHub branch-head compare + installation-token mint
    // BEFORE the container start() throws capacity, so continuing to drain the
    // batch at fleet capacity burns a GitHub/token round-trip per build for builds
    // that will all hit the same full fleet. The scheduler must STOP at the first
    // capacity error: only the build it already claimed (b1) is requeued, the rest
    // of the batch (b2) is never claimed or started, and the alarm re-arms with the
    // jittered capacity backoff.
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    // b1 is oldest (scanned first), b2 newer. Distinct projects so both would be
    // startable absent the capacity shed.
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', age: 2 });
    enqueue({ id: 'b2', user_id: 'u1', project_id: 'p2', age: 1 });
    const startBuild = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // startBuild was attempted exactly once — for b1 — then the scan broke.
    expect(startBuild).toHaveBeenCalledOnce();
    expect((startBuild.mock.calls[0][0] as { buildId: string }).buildId).toBe('b1');
    // b2 was NEVER claimed (the scan broke before reaching it).
    expect(db.claimArgs).toEqual([{ buildId: 'b1', userId: 'u1', projectId: 'p1', limit: 3 }]);
    // Only b1 (the claimed row) was requeued; nothing failed.
    expect(db.requeued).toEqual(['b1']);
    expect(db.failed).toEqual([]);
    // The alarm re-armed with the capacity backoff (>= now + 20s).
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0] as number;
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('does NOT requeue a concurrently-cancelled build on the capacity path (guarded CAS no-ops)', async () => {
    // Regression: the capacity-shed retry used an UNCONDITIONAL
    // updateBuildStatus('queued'). If a concurrent terminalizer
    // (terminateBuildsForProject from push-supersede / branch-executor change /
    // disconnect / install removal) flipped the claimed `starting` row to
    // `cancelled` while startBuild was in flight, an unconditional write would
    // resurrect it (cancelled -> queued) and a superseded commit could later
    // deploy. The guarded `requeueBuildIfStarting` CAS (starting -> queued only)
    // no-ops on the now-terminal row, preserving the cancelled status.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      // The concurrent cancel lands while startBuild is in flight, then the fleet
      // is full so start() throws the capacity error the scheduler must shed.
      db.terminalized.add('b1');
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // The guarded CAS no-opped: the build is NOT requeued (terminal preserved)
    // and was not marked failed either.
    expect(db.requeued).toEqual([]);
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
  });

  it('fails a build (not requeued) when startBuild throws a deterministic error', async () => {
    // A non-capacity throw (e.g. a transport-level RPC failure, or any error that
    // is NOT the fleet-full capacity error) is NOT transient platform pressure —
    // it must still be marked failed so the slot frees, exactly as before. Only
    // the capacity error is requeued.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      throw new Error('boom');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.failed.some((f) => f.id === 'b1' && /boom/.test(f.error))).toBe(true);
    expect(db.requeued).toEqual([]);
  });

  // the RPC-fail catch finalizes via the CAS `markBuildTerminalIfActive`, NOT
  // an unconditional updateBuildStatus('failed'). If a concurrent cancel
  // (terminateBuildsForProject commits 'cancelled', then cancelBuild RPC) drove
  // the claimed `starting` row terminal while startBuild was in flight, an
  // unconditional write would clobber that 'cancelled' to 'failed'. The CAS must
  // no-op on the already-terminal row (nothing failed/cancelled recorded by the
  // scheduler), and the alarm still re-arms while queued work remains.
  it('does NOT clobber a concurrently-cancelled build when the startBuild RPC throws a deterministic error', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      // The concurrent cancel lands (commits 'cancelled' out-of-band) while
      // startBuild is in flight, then the RPC fails with a deterministic (non-
      // capacity) transport error the scheduler would otherwise mark failed.
      db.terminalized.add('b1');
      throw new Error('rpc transport failed');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // The CAS no-opped against the already-terminal row: NOT failed (would have
    // clobbered the cancel) and NOT requeued (this is not the capacity path).
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
    expect(db.requeued).toEqual([]);
  });

  // The RPC-fail catch's terminal write is itself a Hyperdrive/Postgres call. If
  // it THROWS (transient outage), the error must not escape `alarm()` — that
  // would abort the rest of the scan AND skip the tail reschedule, so the global
  // scheduler goes quiet while queued work remains and the failed row holds its
  // slot until an unrelated poke or the stale reaper. The write is best-effort:
  // swallow + log, keep draining, keep the heartbeat armed.
  it('keeps scanning and re-arms the alarm when the RPC-fail terminal write throws (slot-safe)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.users.set('u2', { plan: 'free', login: 'hubot' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2' });
    const startBuild = vi.fn(async (cfg: { buildId: string }) => {
      if (cfg.buildId === 'b1') {
        throw new Error('rpc transport failed');
      }
    });
    // The catch's markBuildTerminalIfActive hits a transient DB outage.
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild as unknown as ReturnType<typeof vi.fn>);
    const s = makeScheduler(ctx, env);

    // (a) alarm() resolves — the write error does not escape.
    await expect(s.alarm()).resolves.toBeUndefined();

    // (b) the scan continued past b1: b2 was still claimed and started.
    expect(startBuild).toHaveBeenCalledTimes(2);
    expect((startBuild.mock.calls[1][0] as { buildId: string }).buildId).toBe('b2');

    // (c) the tail heartbeat re-armed (queued work remains in the mock queue),
    // so b1 — still `starting` in the DB — is reaped on a later tick instead of
    // the scheduler going dark.
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  it('cancels a queued build whose branch no longer matches the connection (DiD)', async () => {
    // Defense-in-depth: a build was queued for `main`, but the connection has
    // since been retargeted to `develop` (or the enqueue serialization missed a
    // race). The scheduler must refuse to START the stale-config build — it marks
    // it `cancelled` ('github connection config changed') and never calls
    // startBuild. A config change is not a build failure, so it is NOT failed, and
    // the JIT branch-head check in BuildManager would not catch this (it is
    // branch-HEAD-only). `build.branch != null` so a null-branch legacy row is
    // exempt (covered by the existing tests that use the default 'main' branch).
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: 'main' });
    // Connection retargeted to a different branch after the build was queued.
    db.connections.set('p1', {
      repo_full_name: 'owner/repo',
      installation_id: 'inst1',
      branch: 'develop',
    });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    // Never claimed (the guard short-circuits before the atomic claim).
    expect(db.claimArgs).toEqual([]);
    // Cancelled with the config-change reason, NOT failed.
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('cancels a queued build whose executor no longer matches the connection (DiD)', async () => {
    // The connection was switched to the github_actions executor after this
    // container build was queued. The container scheduler must not run a build the
    // connection no longer routes to it — same config-match guard, executor half.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: 'main', executor: 'container' });
    db.connections.set('p1', {
      repo_full_name: 'owner/repo',
      installation_id: 'inst1',
      branch: 'main', // branch matches; only the executor differs
      build_executor: 'github_actions',
    });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('reschedules a +2s alarm while the queue still has work', async () => {
    // b1 (u1) is startable; b2 (u2) is left queued because u2 is at their
    // concurrency cap. The end-of-scan `getQueuedBuilds(1)` therefore still
    // sees work, so the alarm must re-arm ~2s ahead.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.users.set('u2', { plan: 'free', login: 'hubot' });
    db.activeByUser.set('u2', 1); // u2 maxed
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2' });
    // b2 stays queued (capped) so the final getQueuedBuilds(1) is non-empty.
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // b1 started, b2 left queued → reschedule.
    expect(startBuild).toHaveBeenCalledOnce();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0] as number;
    expect(armed).toBeGreaterThanOrEqual(now + 2000 - 500);
  });
});
