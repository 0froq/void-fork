import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock cloudflare:workers since DurableObject base class isn't available in unit tests
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

// Mock db.ts (createDb is called inside processUsageEventBatch).
const getUserMock = vi.fn();
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  getUser: (...args: Array<unknown>) => getUserMock(...args),
  suspendUser: vi.fn(),
  unsuspendUserIfReason: vi.fn(),
}));

import type { UsageEvent } from '../../src/usage-counter.ts';
import { groupEventsByUser, processUsageEventBatch } from '../../src/usage-queue.ts';

describe('groupEventsByUser', () => {
  it('groups events by userId', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u2', slug: 's2', requests: 1, responseBytes: 200 },
      { projectId: 'p3', userId: 'u1', slug: 's3', requests: 1, responseBytes: 300 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get('u1')).toHaveLength(2);
    expect(grouped.get('u2')).toHaveLength(1);
  });

  it('returns empty map for empty events', () => {
    const grouped = groupEventsByUser([]);
    expect(grouped.size).toBe(0);
  });

  it('handles single user with multiple events', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u1', slug: 's2', requests: 1, responseBytes: 200 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(1);
    expect(grouped.get('u1')).toHaveLength(2);
  });
});

type FakeStubFetch = (req: Request) => Promise<Response>;

function fetchCalls(mock: ReturnType<typeof vi.fn>): Array<[Request, ...Array<unknown>]> {
  return (mock as unknown as { mock: { calls: Array<[Request, ...Array<unknown>]> } }).mock.calls;
}

function makeBatch(events: ReadonlyArray<UsageEvent>) {
  const messages = events.map((event) => ({ body: event }));
  const calls = { retryAll: 0, ackAll: 0 };
  return {
    queue: 'void-usage-events',
    messages,
    retryAll: () => {
      calls.retryAll++;
    },
    ackAll: () => {
      calls.ackAll++;
    },
    calls,
  };
}

function makeEnv(stubFetch: FakeStubFetch) {
  const errorStubFetch: FakeStubFetch = async () => new Response(null, { status: 200 });
  return {
    HYPERDRIVE: { connectionString: 'postgres://mock' },
    USAGE_COUNTER: {
      idFromName: (name: string) => ({ __id: name }),
      get: (_id: unknown) => ({ fetch: stubFetch }),
    },
    ERROR_ALERT_MONITOR: {
      idFromName: (name: string) => ({ __id: name }),
      get: (_id: unknown) => ({ fetch: errorStubFetch }),
    },
  };
}

describe('processUsageEventBatch — sandbox events', () => {
  beforeEach(() => {
    getUserMock.mockReset();
  });

  it('forwards a sandbox event with userId to the DO', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxRuntimeSeconds: 30,
        sandboxInstanceId: 'sb-1',
      },
    ];
    const batch = makeBatch(events);
    const env = makeEnv(stubFetch);

    await processUsageEventBatch(batch as never, env as never);

    expect(stubFetch).toHaveBeenCalledTimes(1);
    const callReq = fetchCalls(stubFetch)[0][0];
    const payload = (await callReq.json()) as {
      events: Array<UsageEvent>;
      userId: string;
    };
    expect(payload.userId).toBe('u1');
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].sandboxRuntimeSeconds).toBe(30);
    expect(batch.calls.ackAll).toBe(1);
  });
});
