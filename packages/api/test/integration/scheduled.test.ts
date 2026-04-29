import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { scheduled } from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

const mockController = {} as ScheduledController;
const mockCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeBindings(e: TestEnv) {
  return {
    HYPERDRIVE: e.HYPERDRIVE as unknown as Hyperdrive,
    ISR_CACHE: e.ISR_CACHE,
    ROUTING: e.ROUTING,
    STATIC_ASSETS: e.STATIC_ASSETS,
    STATIC_ASSETS_R2: e.STATIC_ASSETS_R2,
    DISPATCH: e.DISPATCH,
    CF_API_TOKEN: e.CF_API_TOKEN,
    CF_ACCOUNT_ID: e.CF_ACCOUNT_ID,
    CF_ZONE_ID: e.CF_ZONE_ID,
    JWT_SECRET: e.JWT_SECRET,
    PROJECT_SECRET_KEYS_JSON: e.PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: e.PROJECT_SECRET_ACTIVE_KEY_VERSION,
    GITHUB_CLIENT_ID: e.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: e.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
    USAGE_COUNTER: e.USAGE_COUNTER,
    CRON_SCHEDULER: e.CRON_SCHEDULER,
    ERROR_ALERT_MONITOR: e.ERROR_ALERT_MONITOR,
    CRON_FIRES_QUEUE: { send: async () => {}, sendBatch: async () => {} } as unknown as Queue<
      import('../../src/cron-fires-queue.ts').CronFireMessage
    >,
  };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

describe('scheduled()', () => {
  it('completes without error on empty database', async () => {
    await expect(scheduled(mockController, makeBindings(env), mockCtx)).resolves.toBeUndefined();
  });

  it('skips unlimited plan users', async () => {
    const { id } = await createTestUser(env.db, 'sponsor', 'github', undefined, 'sponsored');
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: 'test' }));

    // Should complete without errors (skips unlimited plans for usage counting)
    await scheduled(mockController, makeBindings(env), mockCtx);

    // userId backfill still runs for all plans (needed for 5xx alerting)
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.userId).toBe(id);
  });

  it('skips users with no projects', async () => {
    await createTestUser(env.db, 'noprojects', 'github', undefined, 'free');
    await expect(scheduled(mockController, makeBindings(env), mockCtx)).resolves.toBeUndefined();
  });

  it('backfills userId into routing entries', async () => {
    const { id } = await createTestUser(env.db, 'backfill', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    // Old routing entry without userId
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: 'test', projectId: proj.id }));

    await scheduled(mockController, makeBindings(env), mockCtx);

    // Should have userId backfilled
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.userId).toBe(id);
  });

  it('does not overwrite existing userId in routing entries', async () => {
    const { id } = await createTestUser(env.db, 'existing', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    // Routing entry already has userId
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ worker: 'test', projectId: proj.id, userId: 'existing-user-id' }),
    );

    await scheduled(mockController, makeBindings(env), mockCtx);

    // Should preserve existing userId
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.userId).toBe('existing-user-id');
  });

  it('processes multiple batches of users', async () => {
    for (let i = 0; i < 55; i++) {
      const { id } = await createTestUser(env.db, `batchuser${i}`, 'github', undefined, 'free');
      const proj = await createTestProject(env.db, id);
      await env.ROUTING.put(proj.slug, JSON.stringify({ worker: 'test', projectId: proj.id }));
    }

    // Should complete without errors across multiple batches
    await expect(scheduled(mockController, makeBindings(env), mockCtx)).resolves.toBeUndefined();
  });

  it('isolates errors — one user failure does not block others', async () => {
    // Create two users
    const { id: id1 } = await createTestUser(env.db, 'user1', 'github', undefined, 'free');
    const proj1 = await createTestProject(env.db, id1);
    await env.ROUTING.put(proj1.slug, JSON.stringify({ worker: 'test', projectId: proj1.id }));

    const { id: id2 } = await createTestUser(env.db, 'user2', 'github', undefined, 'free');
    const proj2 = await createTestProject(env.db, id2);
    await env.ROUTING.put(proj2.slug, JSON.stringify({ worker: 'test', projectId: proj2.id }));

    // Use a USAGE_COUNTER that fails for the first user but works for the second
    let callCount = 0;
    const failingMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          callCount++;
          // Fail on first rollover call (first user), succeed on rest
          if (callCount === 1) {
            throw new Error('DO failure');
          }
          const url = new URL(req.url);
          if (url.pathname === '/rollover') {
            return Response.json({ rolled: false });
          }
          if (url.pathname === '/init') {
            return Response.json({ ok: true });
          }
          return Response.json({});
        },
      }),
    } as unknown as DurableObjectNamespace;

    const bindings = { ...makeBindings(env), USAGE_COUNTER: failingMock };

    // Should not throw despite first user failing
    await expect(scheduled(mockController, bindings, mockCtx)).resolves.toBeUndefined();

    // Second user should still have userId backfilled
    const routing2 = JSON.parse((await env.ROUTING.get(proj2.slug))!);
    expect(routing2.userId).toBe(id2);
  });
});
