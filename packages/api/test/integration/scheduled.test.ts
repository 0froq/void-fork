import { eq, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import { scheduled } from '../../src/index.ts';
import { getProjectQueueName } from '../../src/naming.ts';
import { deployments, domains, projects } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  cfSuccess,
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
    R2_ACCESS_KEY_ID: e.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: e.R2_SECRET_ACCESS_KEY,
    R2_STATIC_ASSETS_BUCKET: e.R2_STATIC_ASSETS_BUCKET,
    GITHUB_CLIENT_ID: e.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: e.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
    USAGE_COUNTER: e.USAGE_COUNTER,
    CRON_SCHEDULER: e.CRON_SCHEDULER,
    ERROR_ALERT_MONITOR: e.ERROR_ALERT_MONITOR,
    SANDBOX_CONCURRENCY_COUNTER: e.SANDBOX_CONCURRENCY_COUNTER,
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
  // The live-routing reconciler now reads the worker's baked __VOID_PROXY_TOKEN
  // via the CF API (mocked per-test with `mockCfApi`). Restore spies and the
  // global `fetch` stub between tests so a mock installed by one test cannot
  // leak into the next.
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  // F21: `processUserRollover`'s userId backfill is a read-modify-write of the
  // slug routing entry. Pre-fix it read, backfilled `userId`, and wrote back
  // WITHOUT the project lock — so a concurrent deploy/rollback publishing a NEW
  // slug route in the window between the read and the write is CLOBBERED (and
  // since the newer active is `routing_published=true`, the reconciler never
  // heals it). Post-fix the RMW takes the project FOR UPDATE lock and RE-READS
  // under the lock, so a publish that landed in the window is observed (its
  // `userId` is present → no-op) and survives.
  //
  // Discriminator: spy `env.ROUTING.get` so that the FIRST read of the legacy
  // (no-userId) slug entry injects a concurrent publish of a NEWER route
  // (different worker/version, already carrying `userId`) right after the read.
  // Post-fix: the under-lock RE-READ sees the newer entry's `userId` → no-op →
  // the newer route SURVIVES (PASS). Pre-fix: there is no re-read, so the
  // rollover writes its stale legacy+userId snapshot back → the newer route is
  // CLOBBERED (FAIL).
  it('F21: a concurrent publish during the userId backfill RMW is not clobbered', async () => {
    const { id } = await createTestUser(env.db, 'f21-rmw', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);

    // Legacy slug entry WITHOUT userId (the only thing the backfill writes for).
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ worker: 'legacy-worker', version: 'legacy', projectId: proj.id }),
    );

    // The newer route a concurrent deploy/rollback publishes mid-RMW. It already
    // carries `userId` (every current writer does) — the value the backfill must
    // not clobber.
    const newerRoute = JSON.stringify({
      worker: 'newer-worker',
      version: 'newer',
      projectId: proj.id,
      userId: id,
    });

    let injected = false;
    const realGet = env.ROUTING.get.bind(env.ROUTING) as (
      key: string,
      type?: never,
    ) => Promise<unknown>;
    const getSpy = vi.spyOn(env.ROUTING, 'get').mockImplementation((async (
      key: string,
      type: never,
    ) => {
      const result = await realGet(key, type);
      // After the FIRST read of the legacy slug entry, simulate a concurrent
      // deploy/rollback publishing the newer route — BEFORE the rollover's
      // under-lock re-read + write. One-shot.
      if (key === proj.slug && !injected) {
        injected = true;
        await env.ROUTING.put(proj.slug, newerRoute);
      }
      return result;
    }) as typeof env.ROUTING.get);

    try {
      await scheduled(mockController, makeBindings(env), mockCtx);
    } finally {
      getSpy.mockRestore();
    }

    // The newer route SURVIVES — the backfill re-read under the lock, saw its
    // `userId`, and did not overwrite it.
    const final = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(final.worker).toBe('newer-worker');
    expect(final.version).toBe('newer');
    expect(final.userId).toBe(id);
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

  // The hourly live-routing reconciler republishes slug/account/domain routing
  // for recently-live active deployments whose ROUTING KV is missing or stale.
  // Closes the gap where a deploy commits live (pg pointer flipped) but the
  // post-tx routing publish fails — leaving a FIRST deploy unreachable.
  describe('live-routing reconcile', () => {
    // Hourly controller (cron undefined ≠ FAST_CRON) with a concrete
    // scheduledTime so the recency window is deterministic.
    const hourlyController = { scheduledTime: Date.now() } as unknown as ScheduledController;

    // Seed a project whose pg active deployment is live with the given manifest,
    // controlling deployed_at so recency can be exercised. `routing_published`
    // defaults to NULL (qualifies for reconcile) unless overridden.
    async function seedLiveProject(
      userId: string,
      opts: {
        type?: 'void' | 'spa' | 'static' | 'framework';
        manifest?: unknown;
        agedHours?: number;
        assetHashes?: string | null;
        routingPublished?: boolean | null;
      } = {},
    ): Promise<{ projectId: string; slug: string; deploymentId: string }> {
      const proj = await createTestProject(env.db, userId);
      if (opts.type) {
        await env.db.update(projects).set({ type: opts.type }).where(eq(projects.id, proj.id));
      }
      const dep = await createTestDeployment(env.db, proj.id, 'live');
      await env.db
        .update(deployments)
        .set({
          manifest: JSON.stringify(opts.manifest ?? { type: opts.type ?? 'void' }),
          ...(opts.assetHashes !== undefined ? { asset_hashes: opts.assetHashes } : {}),
          ...(opts.routingPublished !== undefined
            ? { routing_published: opts.routingPublished }
            : {}),
          ...(opts.agedHours
            ? { deployed_at: sql`now() - (${opts.agedHours} || ' hour')::interval` }
            : {}),
        })
        .where(eq(deployments.id, dep.id));
      return { projectId: proj.id, slug: proj.slug, deploymentId: dep.id };
    }

    // Read the durable publish-complete marker for a deployment.
    async function readRoutingPublished(deploymentId: string): Promise<boolean | null> {
      const [row] = await env.db
        .select({ routing_published: deployments.routing_published })
        .from(deployments)
        .where(eq(deployments.id, deploymentId));
      return row?.routing_published ?? null;
    }

    it('heals a FIRST deploy with no slug routing entry and marks routing_published', async () => {
      const { id } = await createTestUser(env.db, 'heal-first', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        manifest: { type: 'void', ssr: true },
      });
      // No ROUTING entry at all — the project is unreachable.
      expect(await env.ROUTING.get(slug)).toBeNull();
      expect(await readRoutingPublished(deploymentId)).toBeNull();

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      expect(slugEntry.version).toBe(deploymentId);
      expect(slugEntry.userId).toBe(id);
      expect(slugEntry.ssr).toBe(true);
      // The per-project account entry the rollback path omits is written here.
      const account = JSON.parse((await env.ROUTING.get(`project:${projectId}`))!);
      expect(account).toEqual({ userId: id, plan: 'free' });
      // Marker flips true so the row converges.
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    it('heals a partial publish: slug present+current but domain (and account) missing', async () => {
      const { id } = await createTestUser(env.db, 'heal-partial', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        manifest: { type: 'void' },
      });
      // Slug route is PRESENT and already points at the active deployment (the
      // slug write succeeded), carrying a suspended marker — but the deploy died
      // before writing the account entry and the active domain. The old
      // slug-version fast path would skip this row forever; the marker does not.
      await env.ROUTING.put(
        slug,
        JSON.stringify({
          projectId,
          userId: id,
          version: deploymentId,
          type: 'void',
          suspended: 'x',
        }),
      );
      await env.db.insert(domains).values({
        id: `dom_partial_${Date.now()}`,
        project_id: projectId,
        hostname: 'partial.example.com',
        status: 'active',
        cf_hostname_id: 'ch-partial',
      });
      // Account + domain routes are absent.
      expect(await env.ROUTING.get(`project:${projectId}`)).toBeNull();
      expect(await env.ROUTING.get('domain:partial.example.com')).toBeNull();

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      // Account and domain are now written...
      const account = JSON.parse((await env.ROUTING.get(`project:${projectId}`))!);
      expect(account).toEqual({ userId: id, plan: 'free' });
      const domainEntry = JSON.parse((await env.ROUTING.get('domain:partial.example.com'))!);
      expect(domainEntry.version).toBe(deploymentId);
      // ...slug rebuilt byte-identically (suspended carried forward)...
      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      expect(slugEntry.version).toBe(deploymentId);
      expect(slugEntry.suspended).toBe('x');
      // ...and the marker flips true.
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    it('heals a missing queue route with the exact deploy-path shape (baked token)', async () => {
      const { id } = await createTestUser(env.db, 'heal-queue', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: {
          type: 'void',
          queues: [{ name: 'my_queue', bindingName: 'MY_QUEUE' }],
        },
      });
      // The reconciler sources the queue proxyToken from the worker's baked
      // __VOID_PROXY_TOKEN binding (default mock returns 'mock-proxy-token'),
      // NOT a recompute of hmacSignState — see the rotation test below.
      mockCfApi();
      const queueKey = `queue:${getProjectQueueName(projectId, 'my_queue')}`;
      expect(await env.ROUTING.get(queueKey)).toBeNull();

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      const queueEntry = JSON.parse((await env.ROUTING.get(queueKey))!);
      expect(queueEntry.workerName).toBe(`user-${slug}-${deploymentId}`);
      expect(queueEntry.queueName).toBe('my_queue');
      expect(queueEntry.projectId).toBe(projectId);
      // Baked token, not the recomputed HMAC.
      expect(queueEntry.proxyToken).toBe('mock-proxy-token');
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    it('queue route proxyToken is the worker BAKED token, not a recomputed HMAC (post-rotation)', async () => {
      const { id } = await createTestUser(env.db, 'heal-queue-rot', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: {
          type: 'void',
          queues: [{ name: 'my_queue', bindingName: 'MY_QUEUE' }],
        },
      });
      const workerName = `user-${slug}-${deploymentId}`;
      // Simulate a post-deploy JWT_SECRET rotation: the worker's BAKED token
      // differs from what hmacSignState would now recompute. The healed route
      // MUST carry the baked value (exact-compared by the user worker) — a
      // recompute would 401 the worker into retryAll() forever.
      const bakedToken = 'baked-after-rotation-token';
      const recomputed = await hmacSignState(projectId, env.JWT_SECRET);
      expect(bakedToken).not.toBe(recomputed);
      mockCfApi({
        listWorkerBindings: (url: string) => {
          // Only the active worker's bindings resolve to the baked token.
          expect(url).toContain(workerName);
          return cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: bakedToken }]);
        },
      });

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      const queueKey = `queue:${getProjectQueueName(projectId, 'my_queue')}`;
      const queueEntry = JSON.parse((await env.ROUTING.get(queueKey))!);
      expect(queueEntry.proxyToken).toBe(bakedToken);
      expect(queueEntry.proxyToken).not.toBe(recomputed);
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    it('a transient CF error resolving the queue token leaves the row unmarked (retried)', async () => {
      const { id } = await createTestUser(env.db, 'heal-queue-err', 'github', undefined, 'free');
      const { projectId, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: {
          type: 'void',
          queues: [{ name: 'my_queue', bindingName: 'MY_QUEUE' }],
        },
      });
      const queueKey = `queue:${getProjectQueueName(projectId, 'my_queue')}`;
      // CF bindings read fails transiently → getDispatchWorkerProxyToken returns
      // { kind: 'error' } → the reconciler MUST NOT write a guessed token and
      // MUST leave routing_published unset so the row retries next run.
      mockCfApi({
        listWorkerBindings: () =>
          new Response(
            JSON.stringify({ success: false, errors: [{ code: 10013, message: 'rate limited' }] }),
            { status: 429 },
          ),
      });

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      // No queue route written with a guessed token...
      expect(await env.ROUTING.get(queueKey)).toBeNull();
      // ...and the row is left unmarked so it retries.
      expect(await readRoutingPublished(deploymentId)).toBeNull();
    });

    it('sweeps a stale queue route the active manifest no longer binds', async () => {
      const { id } = await createTestUser(env.db, 'heal-queue-sweep', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: {
          type: 'void',
          queues: [{ name: 'a', bindingName: 'A' }],
        },
      });
      mockCfApi();
      const liveKey = `queue:${getProjectQueueName(projectId, 'a')}`;
      const staleKey = `queue:${getProjectQueueName(projectId, 'b')}`;
      // The active manifest binds queue 'a' (so its route must be WRITTEN), but a
      // STALE `queue:<pid>-b` route survives from a previous deployment whose
      // rollback publish died before its own delete-sweep. The reconciler must
      // mirror that sweep: drop the route absent from the active manifest.
      await env.ROUTING.put(
        staleKey,
        JSON.stringify({
          workerName: `user-${slug}-old-deployment`,
          projectId,
          queueName: 'b',
          proxyToken: 'mock-proxy-token',
        }),
      );
      expect(await env.ROUTING.get(liveKey)).toBeNull();
      expect(await env.ROUTING.get(staleKey)).not.toBeNull();

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      // 'a' written from the active manifest...
      const liveEntry = JSON.parse((await env.ROUTING.get(liveKey))!);
      expect(liveEntry.workerName).toBe(`user-${slug}-${deploymentId}`);
      expect(liveEntry.queueName).toBe('a');
      // ...and the stale 'b' route swept away.
      expect(await env.ROUTING.get(staleKey)).toBeNull();
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    it('sweeps a stale queue route for a STATIC active deployment (empty expected set)', async () => {
      const { id } = await createTestUser(env.db, 'heal-static-sweep', 'github', undefined, 'free');
      // Active deployment is STATIC (became static via rollback or a static
      // redeploy) — it binds NO queues and has NO consumer worker. A stale
      // `queue:<pid>-old` route survives from a prior WfP deployment whose
      // rollback/deploy publish died before its own sweep. The reconciler must
      // run the sweep with an EMPTY expected set even though the active target is
      // static, or the dead route keeps dispatching batches to the evicted worker.
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        type: 'static',
        manifest: { type: 'static' },
      });
      mockCfApi();
      const staleKey = `queue:${getProjectQueueName(projectId, 'old')}`;
      await env.ROUTING.put(
        staleKey,
        JSON.stringify({
          workerName: `user-${slug}-old-deployment`,
          projectId,
          queueName: 'old',
          proxyToken: 'mock-proxy-token',
        }),
      );
      expect(await env.ROUTING.get(staleKey)).not.toBeNull();

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      // The stale queue route is swept even though the active target is static.
      expect(await env.ROUTING.get(staleKey)).toBeNull();
      // Static routing still publishes + marks.
      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      expect(slugEntry.staticDeploymentId).toBe(deploymentId);
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    it('heals WfP asset-fallback metadata when asset_hashes is non-null', async () => {
      const { id } = await createTestUser(env.db, 'heal-assets', 'github', undefined, 'free');
      const { slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: { type: 'void', assetConfig: { not_found_handling: '404-page' } },
        assetHashes: JSON.stringify({ '/index.html': { hash: 'abc', size: 1 } }),
      });
      // Slug missing — full rebuild must include the asset fields.
      expect(await env.ROUTING.get(slug)).toBeNull();

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      expect(slugEntry.version).toBe(deploymentId);
      expect(slugEntry.assetManifestId).toBe(deploymentId);
      expect(slugEntry.assetConfig).toEqual({ not_found_handling: '404-page' });
    });

    it('does NOT include asset fields when asset_hashes is null', async () => {
      const { id } = await createTestUser(env.db, 'heal-noassets', 'github', undefined, 'free');
      const { slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: { type: 'void' },
        assetHashes: null,
      });

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      expect(slugEntry.version).toBe(deploymentId);
      expect(slugEntry.assetManifestId).toBeUndefined();
      expect(slugEntry.assetConfig).toBeUndefined();
    });

    it('the marker gates: routing_published=true → ZERO puts for that project', async () => {
      const { id } = await createTestUser(env.db, 'heal-marked', 'github', undefined, 'free');
      const { projectId, slug } = await seedLiveProject(id, {
        manifest: { type: 'void' },
        routingPublished: true,
      });
      // Even though there is NO routing entry, the durable marker is authoritative
      // — the row is filtered out by the query and never touched.
      expect(await env.ROUTING.get(slug)).toBeNull();

      const puts: Array<string> = [];
      const spyRouting = {
        get: (key: string) => env.ROUTING.get(key),
        put: (key: string, value: string) => {
          puts.push(key);
          return env.ROUTING.put(key, value);
        },
        delete: (key: string) => env.ROUTING.delete(key),
      } as unknown as KVNamespace;

      await scheduled(hourlyController, { ...makeBindings(env), ROUTING: spyRouting }, mockCtx);

      // No put touched this project's slug or account entry.
      expect(puts.filter((k) => k === slug || k === `project:${projectId}`)).toEqual([]);
      // Still unreachable — the marker says it was published, so we trust it.
      expect(await env.ROUTING.get(slug)).toBeNull();
    });

    it('converges: a second tick after a heal is a no-op (row filtered out)', async () => {
      const { id } = await createTestUser(env.db, 'heal-converge', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        manifest: { type: 'void' },
      });

      // First tick heals and marks.
      await scheduled(hourlyController, makeBindings(env), mockCtx);
      expect(await readRoutingPublished(deploymentId)).toBe(true);
      const afterFirst = await env.ROUTING.get(slug);
      expect(afterFirst).not.toBeNull();

      // Second tick: the marked row is filtered out → zero puts for it.
      const puts: Array<string> = [];
      const spyRouting = {
        get: (key: string) => env.ROUTING.get(key),
        put: (key: string, value: string) => {
          puts.push(key);
          return env.ROUTING.put(key, value);
        },
        delete: (key: string) => env.ROUTING.delete(key),
      } as unknown as KVNamespace;
      await scheduled(hourlyController, { ...makeBindings(env), ROUTING: spyRouting }, mockCtx);
      expect(puts.filter((k) => k === slug || k === `project:${projectId}`)).toEqual([]);
    });

    it('skips a live deployment older than the recency window', async () => {
      const { id } = await createTestUser(env.db, 'heal-old', 'github', undefined, 'free');
      const { slug } = await seedLiveProject(id, {
        manifest: { type: 'void' },
        agedHours: 48, // older than the 24h window
      });
      // No slug entry, but it's too old to reconcile.
      expect(await env.ROUTING.get(slug)).toBeNull();

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      // Left untouched — still unreachable until a re-deploy.
      expect(await env.ROUTING.get(slug)).toBeNull();
    });

    it('isolates a bad row — an unparseable manifest does not block the next project', async () => {
      const { id } = await createTestUser(env.db, 'heal-iso', 'github', undefined, 'free');
      // First project: unparseable manifest → JSON.parse throws inside the row.
      const bad = await seedLiveProject(id, { manifest: { type: 'void' } });
      await env.db
        .update(deployments)
        .set({ manifest: 'not-json{' })
        .where(eq(deployments.id, bad.deploymentId));
      // Second project: healthy first deploy that must still heal.
      const good = await seedLiveProject(id, { manifest: { type: 'void' } });
      expect(await env.ROUTING.get(good.slug)).toBeNull();

      await expect(
        scheduled(hourlyController, makeBindings(env), mockCtx),
      ).resolves.toBeUndefined();

      // The bad row never healed and stays unmarked (retries next hour)...
      expect(await env.ROUTING.get(bad.slug)).toBeNull();
      expect(await readRoutingPublished(bad.deploymentId)).toBeNull();
      // ...but the good one did and is marked.
      const goodEntry = JSON.parse((await env.ROUTING.get(good.slug))!);
      expect(goodEntry.version).toBe(good.deploymentId);
      expect(await readRoutingPublished(good.deploymentId)).toBe(true);
    });

    it('F1: SKIPS a stale snapshot row whose active pointer moved to a newer deploy (no clobber)', async () => {
      const { id } = await createTestUser(env.db, 'heal-clobber', 'github', undefined, 'free');
      // Deployment A is active+live with routing_published NULL, so the
      // reconciler's snapshot query returns A.
      const a = await seedLiveProject(id, { manifest: { type: 'void', ssr: true } });
      expect(await env.ROUTING.get(a.slug)).toBeNull();

      // SEAM: a concurrent deploy commits + flips the active pointer to a NEWER
      // deployment B and publishes B's routing — AFTER the reconciler's snapshot
      // SELECT but BEFORE A's per-row FOR UPDATE tx. The first KV read of A's
      // slug (which the reconciler does lock-free, before opening the tx) is the
      // seam point: PGlite is single-connection, so the flip MUST complete here,
      // before the reconciler enters its per-row tx — never concurrently inside
      // it — to avoid self-deadlock. Fire once.
      let bDeploymentId = '';
      let flipped = false;
      const realRouting = env.ROUTING;
      const seamRouting = {
        get: async (key: string) => {
          if (key === a.slug && !flipped) {
            flipped = true;
            // Create B (createTestDeployment flips active_deployment_id → B),
            // mark B published, and publish B's routing to the slug.
            const b = await createTestDeployment(env.db, a.projectId, 'live');
            bDeploymentId = b.id;
            await env.db
              .update(deployments)
              .set({
                manifest: JSON.stringify({ type: 'void', ssr: true }),
                routing_published: true,
              })
              .where(eq(deployments.id, b.id));
            await env.db
              .update(projects)
              .set({ active_deployment_id: b.id })
              .where(eq(projects.id, a.projectId));
            await realRouting.put(
              a.slug,
              JSON.stringify({
                projectId: a.projectId,
                userId: id,
                version: b.id,
                type: 'void',
                ssr: true,
              }),
            );
          }
          return realRouting.get(key);
        },
        put: (key: string, value: string) => realRouting.put(key, value),
        delete: (key: string) => realRouting.delete(key),
      } as unknown as KVNamespace;

      await scheduled(hourlyController, { ...makeBindings(env), ROUTING: seamRouting }, mockCtx);

      // The reconciler RE-READ the active pointer under FOR UPDATE, saw it is now
      // B (not A), and SKIPPED A: the slug route still points at B's version,
      // NOT A's stale snapshot.
      const slugEntry = JSON.parse((await env.ROUTING.get(a.slug))!);
      expect(slugEntry.version).toBe(bDeploymentId);
      expect(slugEntry.version).not.toBe(a.deploymentId);
      // A's stale row is NOT marked published (it self-excludes from the next
      // query since it is no longer active; no false convergence on stale data).
      expect(await readRoutingPublished(a.deploymentId)).toBeNull();
      // B (the newer deploy) keeps its own published marker.
      expect(await readRoutingPublished(bDeploymentId)).toBe(true);
    });

    it('publishes active custom-domain routing alongside the slug', async () => {
      const { id } = await createTestUser(env.db, 'heal-domain', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        manifest: { type: 'void' },
      });
      // An active custom domain — its domain:<hostname> route must be healed too.
      await env.db.insert(domains).values({
        id: `dom_${Date.now()}`,
        project_id: projectId,
        hostname: 'heal.example.com',
        status: 'active',
        cf_hostname_id: 'ch-heal',
      });

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      const domainEntry = JSON.parse((await env.ROUTING.get('domain:heal.example.com'))!);
      expect(slugEntry.version).toBe(deploymentId);
      expect(domainEntry.version).toBe(deploymentId);
    });

    // F4 heal half (rollback-specific): a rollback that committed the active-
    // pointer flip but whose post-commit routing publish failed leaves the
    // (older) target as active+live with routing_published=false and a STALE
    // slug route still pointing at the newer deploy. The reconciler must rebuild
    // the slug route from the now-active target's manifest and mark it.
    it('F4: heals a rollback target left active+unpublished with a stale slug route', async () => {
      const { id } = await createTestUser(env.db, 'heal-rollback', 'github', undefined, 'free');
      // The rollback TARGET (older deploy) is now the active deployment but its
      // routing publish failed → routing_published=false.
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: { type: 'void', ssr: true },
        routingPublished: false,
      });
      // Stale slug route from the deploy the rollback replaced (different
      // version) — the reconciler must overwrite it with the target's version.
      await env.ROUTING.put(
        slug,
        JSON.stringify({
          projectId,
          userId: id,
          version: 'dpl_superseded',
          type: 'void',
        }),
      );
      expect(await readRoutingPublished(deploymentId)).toBe(false);

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      // Slug rebuilt from the target's manifest (ssr carried forward) and the
      // version now points at the active target.
      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      expect(slugEntry.version).toBe(deploymentId);
      expect(slugEntry.ssr).toBe(true);
      // Account entry written; marker flipped true so the row converges.
      const account = JSON.parse((await env.ROUTING.get(`project:${projectId}`))!);
      expect(account).toEqual({ userId: id, plan: 'free' });
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    // The recency window bounds only the legacy NULL-marker backfill. A rollback
    // target is usually OLDER than the window (that is what makes it a rollback)
    // — if `false` rows were window-bounded too, a failed rollback publish to a
    // >24h-old target would be invisible to the reconciler forever and dispatch
    // would serve the stale slug route indefinitely.
    it('heals a rollback target OLDER than the recency window (false marker is window-exempt)', async () => {
      const { id } = await createTestUser(env.db, 'heal-rb-old', 'github', undefined, 'free');
      // Rollback target: active+live, explicitly unpublished, aged past the
      // 24h window — the case the NULL-marker path at 48h correctly skips.
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: { type: 'void', ssr: true },
        routingPublished: false,
        agedHours: 48,
      });
      // Stale slug route from the deploy the rollback replaced.
      await env.ROUTING.put(
        slug,
        JSON.stringify({
          projectId,
          userId: id,
          version: 'dpl_superseded',
          type: 'void',
        }),
      );
      expect(await readRoutingPublished(deploymentId)).toBe(false);

      await scheduled(hourlyController, makeBindings(env), mockCtx);

      // Slug rebuilt for the target despite its age, and the marker converges.
      const slugEntry = JSON.parse((await env.ROUTING.get(slug))!);
      expect(slugEntry.version).toBe(deploymentId);
      expect(slugEntry.ssr).toBe(true);
      expect(await readRoutingPublished(deploymentId)).toBe(true);
    });

    // A project being torn down flips status='deleting' but leaves
    // active_deployment_id on the still-live deployment (live is terminal, so it
    // is not marked canceling), deletes the slug / domain:* / queue:* routes
    // lock-free, then cascade-deletes the row LAST. The reconciler must NOT
    // recreate those routes in the gap — once the row is gone it could never
    // heal them, leaving permanent orphans dispatch resolves to a deleted
    // worker. Guarded both by the query (excludes deleting rows) AND the
    // publish chokepoint's under-lock status re-check.
    it("does NOT recreate slug/domain/queue routes for a status='deleting' project", async () => {
      const { id } = await createTestUser(env.db, 'heal-deleting', 'github', undefined, 'free');
      const { projectId, slug, deploymentId } = await seedLiveProject(id, {
        type: 'void',
        manifest: {
          type: 'void',
          queues: [{ name: 'my_queue', bindingName: 'MY_QUEUE' }],
        },
      });
      // An active custom domain on the same project.
      await env.db.insert(domains).values({
        id: `dom_deleting_${Date.now()}`,
        project_id: projectId,
        hostname: 'deleting.example.com',
        status: 'active',
        cf_hostname_id: 'ch-deleting',
      });
      mockCfApi();

      // teardownProject step 1: flip status='deleting' (pointer stays on the
      // still-live deployment, routing_published stays NULL → would otherwise
      // qualify for reconcile).
      await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, projectId));

      // teardownProject step 3: cleanupBestEffortResources deletes the routing
      // KV entries lock-free. They are already absent here (no deploy ran), so
      // assert the starting state.
      const queueKey = `queue:${getProjectQueueName(projectId, 'my_queue')}`;
      expect(await env.ROUTING.get(slug)).toBeNull();
      expect(await env.ROUTING.get('domain:deleting.example.com')).toBeNull();
      expect(await env.ROUTING.get(queueKey)).toBeNull();

      // Track every put so we can prove the reconciler wrote NOTHING for this
      // project (not just that the keys ended up null).
      const puts: Array<string> = [];
      const spyRouting = {
        get: (key: string) => env.ROUTING.get(key),
        put: (key: string, value: string) => {
          puts.push(key);
          return env.ROUTING.put(key, value);
        },
        delete: (key: string) => env.ROUTING.delete(key),
      } as unknown as KVNamespace;

      await scheduled(hourlyController, { ...makeBindings(env), ROUTING: spyRouting }, mockCtx);

      // None of the project's routes were recreated...
      expect(await env.ROUTING.get(slug)).toBeNull();
      expect(await env.ROUTING.get('domain:deleting.example.com')).toBeNull();
      expect(await env.ROUTING.get(queueKey)).toBeNull();
      expect(await env.ROUTING.get(`project:${projectId}`)).toBeNull();
      // ...and not even attempted: zero puts touched this project.
      expect(
        puts.filter(
          (k) =>
            k === slug ||
            k === 'domain:deleting.example.com' ||
            k === queueKey ||
            k === `project:${projectId}`,
        ),
      ).toEqual([]);
      // The marker stays NULL (the row was never published by the reconciler).
      expect(await readRoutingPublished(deploymentId)).toBeNull();
    });
  });

  // A DO mock that always reports `requestsSuspended: <latch>` on /rollover,
  // optionally also reporting a one-time rollover. Mirrors the real DO, which
  // now returns the request latch on every response so the scheduler can
  // reconcile KV against it each pass.
  function makeRequestLatchMock(opts: {
    requestsSuspended: boolean;
    rolled?: boolean;
  }): DurableObjectNamespace {
    return {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/rollover') {
            return Response.json({
              rolled: opts.rolled ?? false,
              unsuspendRequests: opts.rolled ?? false,
              unsuspendAi: false,
              requestsSuspended: opts.requestsSuspended,
            });
          }
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
  }

  it('clears suspended on slug AND active domain routes when the DO reports a request rollover', async () => {
    const { id } = await createTestUser(env.db, 'rolluser', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    await env.db.insert(domains).values({
      id: 'dom_roll_active',
      project_id: proj.id,
      hostname: 'roll-custom.example.com',
      cf_hostname_id: 'cf_roll',
      status: 'active',
    });

    // Routes left `suspended` by the previous period's request cap.
    const suspendedJson = JSON.stringify({
      projectId: proj.id,
      userId: id,
      suspended: 'requests_exceeded',
    });
    await env.ROUTING.put(proj.slug, suspendedJson);
    await env.ROUTING.put('domain:roll-custom.example.com', suspendedJson);

    // DO reports the billing period rolled and the request latch is now clear.
    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: true, requestsSuspended: false }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBeUndefined();
    expect(
      JSON.parse((await env.ROUTING.get('domain:roll-custom.example.com'))!).suspended,
    ).toBeUndefined();
  });

  it('self-heals a stale requests_exceeded marker even on a pass that did NOT roll over', async () => {
    // Models a prior rollover whose KV clear partially failed: the DO latch is
    // already false (period rolled last run) but a route still carries the
    // stale marker. A later, non-rolling pass must reconcile it — proving the
    // cleanup is retryable, not one-shot.
    const { id } = await createTestUser(env.db, 'staleuser', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ projectId: proj.id, userId: id, suspended: 'requests_exceeded' }),
    );

    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: false, requestsSuspended: false }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBeUndefined();
  });

  it('preserves an admin suspension when the request latch is clear (reason-scoped reconcile)', async () => {
    const { id } = await createTestUser(env.db, 'adminuser', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    // Admin-suspended route — the request-cap reconcile must never lift this.
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ projectId: proj.id, userId: id, suspended: 'admin_suspended' }),
    );

    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: false, requestsSuspended: false }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBe('admin_suspended');
  });

  it('does NOT clear a route while the request latch is still set (user genuinely over cap)', async () => {
    const { id } = await createTestUser(env.db, 'overcap', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ projectId: proj.id, userId: id, suspended: 'requests_exceeded' }),
    );

    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: false, requestsSuspended: true }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBe('requests_exceeded');
  });
});
