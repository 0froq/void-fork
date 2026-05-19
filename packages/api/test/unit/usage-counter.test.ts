import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

// Mock db.ts so we can assert suspendUser / unsuspendUserIfReason calls without
// touching Postgres. createDb returns a sentinel — the suspend helpers don't
// inspect it because they're also mocked.
const dbCalls = {
  suspend: [] as Array<{ id: string; reason: string }>,
  unsuspendIfReason: [] as Array<{ id: string; reason: string }>,
};
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  suspendUser: vi.fn(async (_db: unknown, id: string, reason: string) => {
    dbCalls.suspend.push({ id, reason });
  }),
  unsuspendUserIfReason: vi.fn(async (_db: unknown, id: string, reason: string) => {
    dbCalls.unsuspendIfReason.push({ id, reason });
  }),
  // The DO module also re-exports nothing else from db.ts at module scope,
  // so a minimal mock is sufficient.
  getUser: vi.fn(),
}));

import {
  evaluateRequestLimit,
  evaluateAiLimit,
  evaluateSandboxRuntimeLimit,
  UsageCounter,
  type CounterState,
  type UsageEvent,
} from '../../src/usage-counter.ts';

function makeState(overrides: Partial<CounterState> = {}): CounterState {
  return {
    totalRequests: 0,
    totalNeurons: 0,
    totalSandboxSeconds: 0,
    plan: 'free',
    billingPeriodStart: '2026-01-01T00:00:00Z',
    requestsSuspended: false,
    aiSuspended: false,
    sandboxRuntimeSuspended: false,
    projectSlugs: {},
    ...overrides,
  };
}

describe('evaluateRequestLimit', () => {
  it('returns false when within free plan limit (3M)', () => {
    const state = makeState({ totalRequests: 1_000_000, plan: 'free' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);
  });

  it('returns true when exceeding free plan limit', () => {
    const state = makeState({ totalRequests: 2_999_999, plan: 'free' });
    expect(evaluateRequestLimit(state, 2)).toBe(true);
  });

  it('returns true when exactly at free plan limit', () => {
    const state = makeState({ totalRequests: 2_999_990, plan: 'free' });
    expect(evaluateRequestLimit(state, 10)).toBe(true);
  });

  it('returns false for unlimited plans (sponsored)', () => {
    const state = makeState({ totalRequests: 999_999_999, plan: 'sponsored' });
    expect(evaluateRequestLimit(state, 1_000_000)).toBe(false);
  });

  it('returns false for unlimited plans (custom)', () => {
    const state = makeState({ totalRequests: 999_999_999, plan: 'custom' });
    expect(evaluateRequestLimit(state, 1_000_000)).toBe(false);
  });

  it('works for solo plan (10M limit)', () => {
    const state = makeState({ totalRequests: 5_000_000, plan: 'solo' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);

    const atLimit = makeState({ totalRequests: 9_999_999, plan: 'solo' });
    expect(evaluateRequestLimit(atLimit, 2)).toBe(true);
  });

  it('works for pro plan (100M limit)', () => {
    const state = makeState({ totalRequests: 50_000_000, plan: 'pro' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);

    const atLimit = makeState({ totalRequests: 99_999_999, plan: 'pro' });
    expect(evaluateRequestLimit(atLimit, 2)).toBe(true);
  });
});

describe('evaluateAiLimit', () => {
  it('returns true when free plan exceeds 100K neurons', () => {
    const state = makeState({ totalNeurons: 100_001, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when free plan is exactly at 100K neurons', () => {
    const state = makeState({ totalNeurons: 100_000, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when solo plan exceeds 300K neurons', () => {
    const state = makeState({ totalNeurons: 300_001, plan: 'solo' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when pro plan exceeds 500K neurons', () => {
    const state = makeState({ totalNeurons: 500_001, plan: 'pro' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns false for unlimited plans (sponsored)', () => {
    const state = makeState({ totalNeurons: 999_999_999, plan: 'sponsored' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false for unlimited plans (custom)', () => {
    const state = makeState({ totalNeurons: 999_999_999, plan: 'custom' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within free plan limits', () => {
    const state = makeState({ totalNeurons: 50_000, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within solo plan limits', () => {
    const state = makeState({ totalNeurons: 200_000, plan: 'solo' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within pro plan limits', () => {
    const state = makeState({ totalNeurons: 400_000, plan: 'pro' });
    expect(evaluateAiLimit(state)).toBe(false);
  });
});

describe('evaluateSandboxRuntimeLimit', () => {
  it('returns false when within solo plan limit (under 30h)', () => {
    expect(
      evaluateSandboxRuntimeLimit(makeState({ totalSandboxSeconds: 100, plan: 'solo' }), 50),
    ).toBe(false);
  });

  it('returns true when solo plan would exceed limit', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 30 * 3600 - 10, plan: 'solo' }),
        20,
      ),
    ).toBe(true);
  });

  it('returns true when solo plan is exactly at limit', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 30 * 3600 - 10, plan: 'solo' }),
        10,
      ),
    ).toBe(true);
  });

  it('returns false for unlimited plans (sponsored) regardless of usage', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 999_999_999, plan: 'sponsored' }),
        1_000_000,
      ),
    ).toBe(false);
  });

  it('returns false for unlimited plans (custom) regardless of usage', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 999_999_999, plan: 'custom' }),
        1_000_000,
      ),
    ).toBe(false);
  });

  it('works for pro plan (200h limit)', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 100 * 3600, plan: 'pro' }),
        50 * 3600,
      ),
    ).toBe(false);
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 200 * 3600 - 1, plan: 'pro' }),
        1,
      ),
    ).toBe(true);
  });

  it('rejects any non-trivial sandbox use on the free tier (effectively disabled)', () => {
    // free.sandboxRuntimeSecondsPerMonth is 1, so anything >= 1 total seconds
    // is rejected by isWithinLimit.
    expect(
      evaluateSandboxRuntimeLimit(makeState({ totalSandboxSeconds: 0, plan: 'free' }), 1),
    ).toBe(true);
  });
});

// --- UsageCounter DO integration tests ---

type KVCall = ['put' | 'delete', string, ...Array<unknown>];

function makeFakeKV() {
  const store = new Map<string, string>();
  const calls: Array<KVCall> = [];
  return {
    store,
    calls,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      calls.push(['put', key, value]);
      store.set(key, value);
    },
    delete: async (key: string) => {
      calls.push(['delete', key]);
      store.delete(key);
    },
  };
}

function makeFakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    getAlarm: async () => alarm,
    setAlarm: async (ts: number) => {
      alarm = ts;
    },
  };
}

function makeCounter(initialState: Partial<CounterState> = {}) {
  const kv = makeFakeKV();
  const storage = makeFakeStorage();
  // Seed initial state if requested
  if (Object.keys(initialState).length > 0) {
    storage.data.set('state', makeState(initialState));
  }
  const env = {
    ROUTING: kv,
    HYPERDRIVE: { connectionString: 'postgres://mock' },
  };
  const ctx = { storage };

  // Construct directly — we don't call super() because the mocked DurableObject
  // is a noop base class.
  const counter = new UsageCounter(ctx as never, env as never);
  // Vitest mock doesn't run super(); manually assign ctx/env which the real
  // DO base class would normally set.
  (counter as unknown as { ctx: unknown; env: unknown }).ctx = ctx;
  (counter as unknown as { ctx: unknown; env: unknown }).env = env;
  return { counter, kv, storage, env };
}

function recordRequest(events: Array<UsageEvent>, userId: string, plan?: string): Request {
  return new Request('https://do/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events, userId, plan }),
  });
}

function rolloverRequest(billingPeriodStart: string, plan: string, userId?: string): Request {
  return new Request('https://do/rollover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billingPeriodStart, plan, userId }),
  });
}

describe('UsageCounter.handleRecord — sandbox', () => {
  beforeEach(() => {
    dbCalls.suspend.length = 0;
    dbCalls.unsuspendIfReason.length = 0;
  });

  it('accumulates totalSandboxSeconds from a sandbox-only event', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxRuntimeSeconds: 42,
        sandboxInstanceId: 'sb-1',
      },
    ];
    const res = await counter.fetch(recordRequest(events, 'u1', 'pro'));
    expect(res.status).toBe(200);
    const body = await res.json<{
      totalSandboxSeconds: number;
      sandboxRuntimeSuspended: boolean;
    }>();
    expect(body.totalSandboxSeconds).toBe(42);
    expect(body.sandboxRuntimeSuspended).toBe(false);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(42);
  });

  it('updates both totals on a mixed batch (requests + sandbox)', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 5, responseBytes: 100 },
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxRuntimeSeconds: 30,
        sandboxInstanceId: 'sb-1',
      },
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 2,
        responseBytes: 0,
        sandboxRuntimeSeconds: 10,
        sandboxInstanceId: 'sb-1',
      },
    ];
    const res = await counter.fetch(recordRequest(events, 'u1', 'pro'));
    const body = await res.json<{
      totalRequests: number;
      totalSandboxSeconds: number;
    }>();
    expect(body.totalRequests).toBe(7);
    expect(body.totalSandboxSeconds).toBe(40);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalRequests).toBe(7);
    expect(persisted.totalSandboxSeconds).toBe(40);
  });

  it('treats events without sandboxRuntimeSeconds as 0', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 3, responseBytes: 100 },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'pro'));
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(0);
  });

  it('triggers sandbox suspension when crossing the plan limit', async () => {
    // solo: sandboxRuntimeSecondsPerMonth = 30 * 3600 = 108_000
    const { counter, kv, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600 - 10,
    });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxRuntimeSeconds: 20,
        sandboxInstanceId: 'sb-1',
      },
    ];
    const res = await counter.fetch(recordRequest(events, 'u1', 'solo'));
    const body = await res.json<{ sandboxRuntimeSuspended: boolean }>();
    expect(body.sandboxRuntimeSuspended).toBe(true);

    // KV: sandbox-block:u1 was written with '1'
    expect(kv.store.get('sandbox-block:u1')).toBe('1');
    expect(kv.calls).toContainEqual(['put', 'sandbox-block:u1', '1']);

    // DB: suspendUser called with REASON_SANDBOX_RUNTIME_EXCEEDED
    expect(dbCalls.suspend).toContainEqual({ id: 'u1', reason: 'sandbox_runtime_exceeded' });

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.sandboxRuntimeSuspended).toBe(true);
  });

  it('is idempotent: second over-limit batch does not re-write KV or re-call suspendUser', async () => {
    const { counter, kv } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600 - 10,
    });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxRuntimeSeconds: 20,
        sandboxInstanceId: 'sb-1',
      },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'solo'));
    const callsAfterFirst = kv.calls.length;
    const suspendCountAfterFirst = dbCalls.suspend.length;

    // Second over-limit batch
    await counter.fetch(recordRequest(events, 'u1', 'solo'));
    expect(kv.calls.length).toBe(callsAfterFirst); // no new KV writes
    expect(dbCalls.suspend.length).toBe(suspendCountAfterFirst); // no new DB call
  });

  it('does not suspend or write KV when below the limit', async () => {
    const { counter, kv } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxRuntimeSeconds: 60,
        sandboxInstanceId: 'sb-1',
      },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'pro'));
    expect(kv.calls.filter(([op, key]) => op === 'put' && key === 'sandbox-block:u1')).toEqual([]);
    expect(dbCalls.suspend).toEqual([]);
  });
});

describe('UsageCounter.handleRollover — sandbox', () => {
  beforeEach(() => {
    dbCalls.suspend.length = 0;
    dbCalls.unsuspendIfReason.length = 0;
  });

  it('resets totalSandboxSeconds, clears flag, deletes KV, and calls unsuspendUserIfReason', async () => {
    const { counter, kv, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600,
      sandboxRuntimeSuspended: true,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    // Seed the KV key as if it had been written by the previous period's suspension
    kv.store.set('sandbox-block:u1', '1');

    const res = await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'solo', 'u1'));
    const body = await res.json<{ rolled: boolean }>();
    expect(body.rolled).toBe(true);

    // KV deleted
    expect(kv.store.has('sandbox-block:u1')).toBe(false);
    expect(kv.calls).toContainEqual(['delete', 'sandbox-block:u1']);

    // DB unsuspension called
    expect(dbCalls.unsuspendIfReason).toContainEqual({
      id: 'u1',
      reason: 'sandbox_runtime_exceeded',
    });

    // State reset
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(0);
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
  });

  it('skips sandbox cleanup when not previously suspended', async () => {
    const { counter, kv } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 500,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    const res = await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'solo', 'u1'));
    expect(res.status).toBe(200);

    // No KV delete and no DB unsuspend
    expect(
      kv.calls.find(([op, key]) => op === 'delete' && key === 'sandbox-block:u1'),
    ).toBeUndefined();
    expect(dbCalls.unsuspendIfReason).toEqual([]);
  });

  it('no-op when billingPeriodStart unchanged', async () => {
    const { counter, kv } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600,
      sandboxRuntimeSuspended: true,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    kv.store.set('sandbox-block:u1', '1');

    const res = await counter.fetch(rolloverRequest('2026-01-01T00:00:00Z', 'solo', 'u1'));
    const body = await res.json<{ rolled: boolean }>();
    expect(body.rolled).toBe(false);
    expect(kv.store.has('sandbox-block:u1')).toBe(true); // untouched
    expect(dbCalls.unsuspendIfReason).toEqual([]);
  });
});

describe('UsageCounter.handleReevaluateSandbox', () => {
  beforeEach(() => {
    dbCalls.suspend.length = 0;
    dbCalls.unsuspendIfReason.length = 0;
  });

  function reevaluateRequest(plan: string): Request {
    return new Request('https://do/reevaluate-sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
  }

  it('clears sandboxRuntimeSuspended and updates plan when upgrade lifts the limit', async () => {
    // Was suspended on solo (30h). Upgrade to pro (200h). totalSandboxSeconds is below pro's limit.
    const { counter, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600,
      sandboxRuntimeSuspended: true,
    });

    const res = await counter.fetch(reevaluateRequest('pro'));
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.plan).toBe('pro');
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
  });

  it('clears the flag for unlimited plans (sponsored) regardless of total', async () => {
    const { counter, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 1_000_000,
      sandboxRuntimeSuspended: true,
    });

    await counter.fetch(reevaluateRequest('sponsored'));
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.plan).toBe('sponsored');
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
  });

  it('still clears the in-memory flag when usage exceeds the new plan (next handleRecord re-suspends)', async () => {
    // On pro (200h), suspended. Downgrade to solo (30h) while usage is between the two.
    // The DO clears the flag optimistically; the next handleRecord re-evaluates and re-suspends
    // (writing KV + DB).
    const { counter, storage, kv } = makeCounter({
      plan: 'pro',
      totalSandboxSeconds: 100 * 3600,
      sandboxRuntimeSuspended: true,
    });

    await counter.fetch(reevaluateRequest('solo'));
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.plan).toBe('solo');
    expect(persisted.sandboxRuntimeSuspended).toBe(false);

    // Now simulate the next batch — even a zero-second event triggers re-evaluation
    // because totalSandboxSeconds (100h) > solo limit (30h).
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 0, responseBytes: 0 },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'solo'));
    const reSuspended = storage.data.get('state') as CounterState;
    expect(reSuspended.sandboxRuntimeSuspended).toBe(true);
    expect(kv.store.get('sandbox-block:u1')).toBe('1');
    expect(dbCalls.suspend).toContainEqual({ id: 'u1', reason: 'sandbox_runtime_exceeded' });
  });
});
