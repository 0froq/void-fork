import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@void/platform';
import { eq, sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import { signDeployToken, signProjectCredentialToken } from '../../src/auth/deploy-token.ts';
import { cancelDeployment, countUserDeploymentsToday, failStaleDeployments } from '../../src/db.ts';
import {
  dispatchPendingDeployments,
  getDeploymentOperation,
  processDeploymentBatch,
} from '../../src/deployment-execution.ts';
import * as execution from '../../src/deployment-execution.ts';
import type { ApiEnv } from '../../src/env.ts';
import app, { FAST_CRON } from '../../src/index.ts';
import * as cleanup from '../../src/provisioning/cleanup.ts';
import * as deploy from '../../src/routes/deploy.ts';
import {
  builds,
  deploymentOperations,
  deployments,
  projects,
  projectDeployCredentials,
  projectMembers,
  users,
  platformAuthSettings,
} from '../../src/schema.ts';
import type { DeployEvent } from '../../src/types.ts';
import {
  createTestBuild,
  clearTables,
  cfSuccess,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let send: ReturnType<typeof vi.fn>;
let queuedEnv: ApiEnv['Bindings'];
let user: Awaited<ReturnType<typeof createTestUser>>;
let project: Awaited<ReturnType<typeof createTestProject>>;
const hash = 'a'.repeat(32);
const bytes = new TextEncoder().encode('<h1>durable</h1>');

beforeAll(async () => {
  env = await setupEnv();
  await env.db.execute(sql`CREATE TABLE IF NOT EXISTS __void_platform_installation (
    singleton boolean PRIMARY KEY, installation_id text NOT NULL,
    ownership_nonce text NOT NULL DEFAULT 'durable-ownership-fixture',
    lifecycle_manifest jsonb NOT NULL
  )`);
});
afterAll(async () => {
  await env.db.execute(sql`DROP TABLE IF EXISTS __void_platform_installation`);
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
  send = vi.fn(async () => {});
  queuedEnv = { ...env, DEPLOYMENTS_QUEUE: { send } } as unknown as ApiEnv['Bindings'];
  user = await createTestUser(env.db);
  project = await createTestProject(env.db, user.id);
  await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${hash}`, bytes.buffer);
  mockCfApi();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function payload() {
  return {
    manifest: {
      version: 3,
      assetManifestVersion: 2,
      bindings: {},
      type: 'spa',
      assetConfig: { not_found_handling: 'single-page-application' },
    },
    assetManifest: { '/index.html': { blake3: hash, md5: 'b'.repeat(32), size: bytes.byteLength } },
    source: 'manual',
    commit: null,
    preflight: null,
  };
}

async function post(key = crypto.randomUUID(), body: unknown = payload(), jwt = user.jwt) {
  const response = await app.fetch(
    new Request(`https://api.test/projects/${project.id}/deploy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'x-void-deploy-idempotency-key': key,
      },
      body: JSON.stringify(body),
    }),
    queuedEnv,
  );
  // Disconnect every observer immediately. Durable execution must not rely on
  // consuming this response, and no polling timers should escape the test.
  await response.body?.cancel();
  return response;
}

async function admit(key = crypto.randomUUID(), jwt = user.jwt) {
  const response = await post(key, payload(), jwt);
  expect(response.status).toBe(200);
  const id = response.headers.get('x-void-deployment-id');
  expect(id).toMatch(/^dpl_/);
  return id!;
}

function delivery(id: string) {
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    queue: 'void-deployments',
    messages: [{ body: { deploymentId: id }, ack, retry }],
  } as unknown as MessageBatch<unknown>;
  return { batch, ack, retry };
}

async function run(id: string) {
  const message = delivery(id);
  await processDeploymentBatch(message.batch, queuedEnv);
  return message;
}

async function getEvents(
  id: string,
  since: string | number = 0,
  jwt = user.jwt,
  targetProject = project.id,
) {
  return app.fetch(
    new Request(
      `https://api.test/projects/${targetProject}/deployments/${id}/events?since=${since}`,
      {
        headers: { Authorization: `Bearer ${jwt}` },
      },
    ),
    queuedEnv,
  );
}

const installationId = 'durable-installation-fixture';
const probeToken = 'durable-probe-fixture';

async function checkpoint(status = 'installed', desiredState = 'enabled') {
  queuedEnv.PLATFORM_INSTALLATION_ID = installationId;
  queuedEnv.PLATFORM_HEALTH_PROBE_TOKEN = probeToken;
  await env.db.execute(sql`INSERT INTO __void_platform_installation
    (singleton, installation_id, lifecycle_manifest)
    VALUES (true, ${installationId}, ${JSON.stringify({ status, desiredState })}::jsonb)
    ON CONFLICT (singleton) DO UPDATE SET lifecycle_manifest = excluded.lifecycle_manifest`);
}

function probe(headers: Record<string, string> = {}, bindings = queuedEnv) {
  return app.fetch(
    new Request('https://api.test/__void/platform/deployment-execution', { headers }),
    bindings,
  );
}

describe('durable deployment admission and observation', () => {
  it('acknowledges queued work without running it, then publishes the original placeholder after observer disconnect', async () => {
    const id = await admit();
    expect(send).toHaveBeenCalledExactlyOnceWith({ deploymentId: id });
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({
      status: 'queued',
      actor_id: user.id,
      project_id: project.id,
    });
    expect(await env.db.select().from(deployments)).toMatchObject([
      { id, status: 'pending', manifest: null },
    ]);
    expect(await env.ROUTING.get(`slug:${project.slug}`)).toBeNull();
    expect(await countUserDeploymentsToday(env.db, user.id)).toBe(0);

    const message = await run(id);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'live' }]);
    expect(await countUserDeploymentsToday(env.db, user.id)).toBe(1);
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({
      status: 'terminal',
      inputs_deleted: true,
    });
    const page = (await (await getEvents(id)).json()) as {
      deploymentId: string;
      terminal: boolean;
      events: Array<{ seq: number; event: DeployEvent }>;
    };
    expect(page.deploymentId).toBe(id);
    expect(page.terminal).toBe(true);
    expect(page.events.at(-1)?.event).toMatchObject({ event: 'done', deployment: id });
    expect(await env.db.select().from(projects).where(eq(projects.id, project.id))).toMatchObject([
      { active_deployment_id: id },
    ]);
  });

  it('returns one receipt for replayed input before and after execution', async () => {
    const key = crypto.randomUUID();
    const id = await admit(key);
    expect(await admit(key)).toBe(id);
    expect(send).toHaveBeenCalledOnce();
    await run(id);
    expect(await admit(key)).toBe(id);
    expect(await env.db.select().from(deployments)).toHaveLength(1);
    expect(await env.db.select().from(deploymentOperations)).toHaveLength(1);
    expect(await countUserDeploymentsToday(env.db, user.id)).toBe(1);
  });

  it('rejects an idempotency key reused for different content', async () => {
    const key = crypto.randomUUID();
    const id = await admit(key);
    const response = await post(key, { ...payload(), commit: 'different-commit' });
    expect(response.status).toBe(409);
    expect(send).toHaveBeenCalledOnce();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id }]);
  });

  it('rejects a different request while accepted execution remains queued', async () => {
    const id = await admit();
    const response = await post();
    expect(response.status).toBe(409);
    expect(send).toHaveBeenCalledOnce();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id }]);
  });

  it.each([
    ['provisioning', 'enabled'],
    ['failed', 'enabled'],
    ['installed', 'disabled'],
  ])(
    'closes admission at the authoritative %s/%s checkpoint and drains accepted work while disabled',
    async (status, desiredState) => {
      await checkpoint();
      const id = await admit();
      await checkpoint(status, desiredState);
      const response = await post();
      expect(response.status).toBe(409);
      expect(response.headers.get('x-void-deployment-id')).toBeNull();
      expect(send).toHaveBeenCalledOnce();
      expect(await env.db.select().from(deploymentOperations)).toHaveLength(1);
      expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'pending' }]);

      await env.ROUTING.put(PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE);
      const message = delivery(id);
      await app.queue(message.batch, { ...queuedEnv, PLATFORM_TRAFFIC_STATE: 'staging' });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(await getDeploymentOperation(env.db, id)).toMatchObject({ status: 'terminal' });
      expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'live' }]);
    },
  );

  it('keeps the execution probe private and reports persisted pending work across disablement', async () => {
    await checkpoint();
    const id = await admit();
    expect((await probe()).status).toBe(404);
    expect((await probe({ 'X-Void-Platform-Probe': 'wrong' })).status).toBe(404);
    const headers = { 'X-Void-Platform-Probe': probeToken };
    const enabled = await probe(headers);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({
      protocolVersion: 1,
      installationId,
      pendingDeployments: 1,
      admissionClosed: false,
    });
    await checkpoint('installed', 'disabled');
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE);
    const disabledEnv = { ...queuedEnv, PLATFORM_TRAFFIC_STATE: 'staging' };
    const disabled = await probe(headers, disabledEnv);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ pendingDeployments: 1, admissionClosed: true });
    const message = delivery(id);
    await app.queue(message.batch, disabledEnv);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(await (await probe(headers, disabledEnv)).json()).toMatchObject({
      pendingDeployments: 0,
      admissionClosed: true,
    });
  });

  it('requires both installation proof and a signed Access service assertion for the disabled probe', async () => {
    await checkpoint();
    await admit();
    await checkpoint('installed', 'disabled');
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE);
    await importLegacyAuthentication(env.db, env);
    const issuer = 'https://durable.cloudflareaccess.com';
    await env.db.update(platformAuthSettings).set({
      protection: {
        teamDomain: issuer,
        applications: [{ origin: 'https://api.test', audience: 'durable-api' }],
      },
      admission: { mode: 'company', access: true, connections: [] },
    });
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: 'RS256',
      kid: 'durable-key',
      use: 'sig',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (input.toString() === `${issuer}/cdn-cgi/access/certs`) {
          return Response.json({ keys: [jwk] });
        }
        throw new Error('Unexpected outbound request');
      }),
    );
    const assertion = await new SignJWT({ type: 'app', common_name: 'durable.access' })
      .setIssuer(issuer)
      .setAudience('durable-api')
      .setSubject('')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setProtectedHeader({ alg: 'RS256', kid: 'durable-key' })
      .sign(pair.privateKey);
    const bindings = { ...queuedEnv, PLATFORM_TRAFFIC_STATE: 'staging' };
    expect((await probe({ 'X-Void-Platform-Probe': probeToken }, bindings)).status).toBe(403);
    const response = await probe(
      {
        'X-Void-Platform-Probe': probeToken,
        'Cf-Access-Jwt-Assertion': assertion,
      },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pendingDeployments: 1, admissionClosed: true });
    expect((await probe({ 'Cf-Access-Jwt-Assertion': assertion }, bindings)).status).toBe(503);
  });

  it.each(['terminal', 'deleted'] as const)(
    'fences new deploy, rollback, and deletion when the receipt is unfinished but its candidate is %s',
    async (candidate) => {
      const target = await createTestDeployment(env.db, project.id);
      await env.db.update(deployments).set({ retained: true }).where(eq(deployments.id, target.id));
      const id = await admit();
      if (candidate === 'terminal') {
        await env.db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, id));
      } else {
        await env.db.delete(deployments).where(eq(deployments.id, id));
      }
      const previousProject = await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, project.id));
      const previousDeployments = await env.db.select().from(deployments);
      const routing = JSON.stringify({ workerName: 'retained-worker-fixture' });
      await env.ROUTING.put(project.slug, routing);
      const provider = mockCfApi();
      const fresh = await post();
      expect(fresh.status).toBe(409);
      expect(fresh.headers.get('x-void-deployment-id')).toBeNull();
      const rollback = await app.fetch(
        new Request(`https://api.test/projects/${project.id}/rollback`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        queuedEnv,
      );
      expect(rollback.status).toBe(409);
      expect(await rollback.json()).toMatchObject({ error: `deploy in progress: ${id}` });
      const deleted = await app.fetch(
        new Request(`https://api.test/projects/${project.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        queuedEnv,
      );
      expect(deleted.status).toBe(409);
      expect(await deleted.json()).toMatchObject({
        error: expect.stringMatching(/deploy|deployment/i),
      });
      expect(await env.db.select().from(projects).where(eq(projects.id, project.id))).toEqual(
        previousProject,
      );
      expect(await env.db.select().from(deployments)).toEqual(previousDeployments);
      expect(await getDeploymentOperation(env.db, id)).toMatchObject({ status: 'queued' });
      expect(await env.ROUTING.get(project.slug)).toBe(routing);
      expect(send).toHaveBeenCalledOnce();
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it('excludes durable work from the legacy stale reaper while failing an old legacy deployment', async () => {
    const id = await admit();
    const legacyProject = await createTestProject(env.db, user.id);
    const legacy = await createTestDeployment(env.db, legacyProject.id, 'pending');
    await env.db.update(deployments).set({ updated_at: sql`now() - interval '2 hours'` });
    expect(await failStaleDeployments(env.db)).toBe(1);
    expect(await env.db.select().from(deployments).where(eq(deployments.id, id))).toMatchObject([
      { id, status: 'pending' },
    ]);
    expect(
      await env.db.select().from(deployments).where(eq(deployments.id, legacy.id)),
    ).toMatchObject([{ id: legacy.id, status: 'failed', error_message: 'timed out' }]);
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({ status: 'queued' });
  });

  it('survives a missing Queue send acknowledgement through the committed outbox', async () => {
    send.mockRejectedValueOnce(new Error('Queue acknowledgement lost'));
    const id = await admit();
    await env.db
      .update(deploymentOperations)
      .set({ next_dispatch_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(deploymentOperations.id, id));
    await dispatchPendingDeployments(queuedEnv, env.db);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({ status: 'queued' });
    expect((await run(id)).ack).toHaveBeenCalledOnce();
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({ status: 'terminal' });
  });

  it('redispatches the durable outbox on a disabled installation fast tick while skipping application maintenance', async () => {
    await checkpoint();
    send.mockRejectedValueOnce(new Error('Queue acknowledgement lost'));
    const id = await admit();
    await env.db
      .update(deploymentOperations)
      .set({
        next_dispatch_at: sql`now() - interval '1 second'`,
      })
      .where(eq(deploymentOperations.id, id));
    await checkpoint('installed', 'disabled');
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE);
    const cleanupSpy = vi.spyOn(cleanup, 'reconcileProjectCleanupJobs');
    const provider = mockCfApi();
    await app.scheduled(
      {
        cron: FAST_CRON,
        scheduledTime: Date.now(),
        noRetry() {},
      } as ScheduledController,
      queuedEnv,
      {} as ExecutionContext,
    );
    expect(send).toHaveBeenNthCalledWith(2, { deploymentId: id });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({ status: 'queued' });
    expect(await env.ROUTING.get(PLATFORM_DISABLED_KEY)).toBe(PLATFORM_DISABLED_VALUE);
    expect(await env.ROUTING.get(project.slug)).toBeNull();
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('marks only the final cursor page terminal, and keeps a completed receipt readable', async () => {
    const id = await admit();
    const events = Array.from({ length: 100 }, (_, index) => ({
      seq: index + 1,
      event: { event: 'worker_readiness' } as DeployEvent,
    }));
    const done: DeployEvent = {
      event: 'done',
      deployment: id,
      url: 'https://app.test',
      urls: [],
      assets: 1,
      workers: 0,
    };
    events.push({ seq: 101, event: done });
    await env.db
      .update(deploymentOperations)
      .set({ events, last_seq: 101, status: 'terminal' })
      .where(eq(deploymentOperations.id, id));
    const first = (await (await getEvents(id)).json()) as {
      events: Array<unknown>;
      lastSeq: number;
      terminal: boolean;
    };
    expect(first.events).toHaveLength(100);
    expect(first).toMatchObject({ lastSeq: 100, terminal: false });
    expect(await (await getEvents(id, 100)).json()).toMatchObject({
      events: [{ seq: 101, event: done }],
      lastSeq: 101,
      terminal: true,
    });
    expect(await (await getEvents(id, 101)).json()).toMatchObject({
      events: [],
      lastSeq: 101,
      terminal: true,
    });
  });

  it('protects observation with project authorization and rejects a receipt under another owned project', async () => {
    const id = await admit();
    const other = await createTestUser(env.db, 'other-observer');
    const ownedProject = await createTestProject(env.db, user.id);
    const unauthenticated = await app.fetch(
      new Request(`https://api.test/projects/${project.id}/deployments/${id}/events`),
      queuedEnv,
    );
    expect(unauthenticated.status).toBe(401);
    expect((await getEvents(id, 0, other.jwt)).status).toBe(403);
    expect((await getEvents(id, 0, user.jwt, ownedProject.id)).status).toBe(404);
    expect((await getEvents('dpl_missing')).status).toBe(404);
  });

  it.each(['-1', '1.5', 'NaN', '9007199254740992'])(
    'rejects invalid event cursor %s',
    async (cursor) => {
      const id = await admit();
      expect((await getEvents(id, cursor)).status).toBe(400);
    },
  );

  it('keeps the no-op operation receipt after deleting its placeholder, returning the existing active result', async () => {
    const activeId = await admit();
    await run(activeId);
    const noOpId = await admit();
    expect(noOpId).not.toBe(activeId);
    const message = await run(noOpId);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await env.db.select().from(deployments)).toMatchObject([
      { id: activeId, status: 'live' },
    ]);
    expect(await getDeploymentOperation(env.db, noOpId)).toMatchObject({ status: 'terminal' });
    const page = (await (await getEvents(noOpId)).json()) as {
      deploymentId: string;
      events: Array<{ event: DeployEvent }>;
    };
    expect(page.deploymentId).toBe(noOpId);
    expect(page.events.at(-1)?.event).toMatchObject({ event: 'done', deployment: activeId });
    expect(await countUserDeploymentsToday(env.db, user.id)).toBe(1);
  });
});

describe('durable execution claim and revocation', () => {
  it('rejects admitted work from a collaborator suspended before queued execution', async () => {
    const collaborator = await createTestUser(env.db, 'queued-collaborator');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: user.id,
    });
    const id = await admit(crypto.randomUUID(), collaborator.jwt);
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({ actor_id: collaborator.id });
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, collaborator.id));
    const message = await run(id);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'failed' }]);
    expect(await env.ROUTING.get(`slug:${project.slug}`)).toBeNull();
    const operation = await getDeploymentOperation(env.db, id);
    expect(operation).toMatchObject({ status: 'terminal' });
    expect(operation?.events.at(-1)?.event).toMatchObject({
      event: 'error',
      step: 'authorization',
    });
  });

  it('reconciles a live deployment after terminal journal persistence fails without rerunning execution', async () => {
    const id = await admit();
    const execute = vi.spyOn(deploy, 'executeQueuedDeployment');
    const originalAppend = execution.appendDeploymentEvent;
    const append = vi
      .spyOn(execution, 'appendDeploymentEvent')
      .mockImplementation(async (...args) => {
        if (args[3].event === 'done') {
          throw new Error('Terminal journal acknowledgement lost');
        }
        return originalAppend(...args);
      });
    const first = await run(id);
    expect(first.ack).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'live' }]);
    const interrupted = await getDeploymentOperation(env.db, id);
    expect(interrupted).toMatchObject({ status: 'running', inputs_deleted: false });
    expect(
      interrupted?.events.some(({ event }) => event.event === 'done' || event.event === 'error'),
    ).toBe(false);
    append.mockImplementation(originalAppend);
    await env.db
      .update(deploymentOperations)
      .set({ lease_expires_at: sql`now() - interval '1 second'` })
      .where(eq(deploymentOperations.id, id));
    const second = await run(id);
    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({
      status: 'terminal',
      inputs_deleted: true,
    });
    expect((await getDeploymentOperation(env.db, id))?.events.at(-1)?.event).toMatchObject({
      event: 'done',
      deployment: id,
    });
    expect(await countUserDeploymentsToday(env.db, user.id)).toBe(1);
  });

  it('stages Worker bytes before acknowledgement and executes the verified modules after disconnect', async () => {
    queuedEnv.DISPATCH = {
      get: () => ({ fetch: async () => Response.json({ ready: true }) }),
    } as unknown as DispatchNamespace;
    const worker = 'export default { fetch() { return new Response("durable"); } }';
    const uploadedModules: Array<string> = [];
    mockCfApi({
      uploadWorker: async (_url, init) => {
        const module = (init!.body as FormData).get('index.js') as File;
        uploadedModules.push(await module.text());
        return cfSuccess({});
      },
    });
    const response = await post(crypto.randomUUID(), {
      ...payload(),
      manifest: { version: 3, assetManifestVersion: 2, bindings: {}, type: 'void' },
      workerFiles: { 'index.js': btoa(worker) },
    });
    expect(response.status).toBe(200);
    const id = response.headers.get('x-void-deployment-id')!;
    const operation = await getDeploymentOperation(env.db, id);
    expect(operation?.payload.body).not.toHaveProperty('workerFiles');
    expect(operation?.payload.modules).toMatchObject([{ name: 'index.js' }]);
    const moduleKey = operation!.payload.modules[0]!.key;
    const staged = await env.STATIC_ASSETS_R2.get(moduleKey);
    expect(new TextDecoder().decode(await staged!.arrayBuffer())).toBe(worker);
    const message = await run(id);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'live' }]);
    expect(uploadedModules).toEqual([worker]);
    expect((await getDeploymentOperation(env.db, id))?.events.at(-1)?.event).toMatchObject({
      event: 'done',
      deployment: id,
      workers: 1,
    });
    expect(await env.STATIC_ASSETS_R2.get(moduleKey)).toBeNull();
  });

  it('does not upload corrupt staged modules or acknowledge an unknown execution outcome', async () => {
    const response = await post(crypto.randomUUID(), {
      ...payload(),
      manifest: { version: 3, assetManifestVersion: 2, bindings: {}, type: 'void' },
      workerFiles: { 'index.js': btoa('export default {};') },
    });
    const id = response.headers.get('x-void-deployment-id')!;
    const operation = await getDeploymentOperation(env.db, id);
    await env.STATIC_ASSETS_R2.put(operation!.payload.modules[0]!.key, 'corrupted module');
    const message = await run(id);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'pending' }]);
    expect(await env.ROUTING.get(`slug:${project.slug}`)).toBeNull();
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({
      status: 'running',
      events: [],
    });
  });

  it('claims concurrent duplicate Queue messages once and acknowledges later duplicates', async () => {
    const id = await admit();
    const execute = vi.spyOn(deploy, 'executeQueuedDeployment');
    const first = delivery(id);
    const second = delivery(id);
    await Promise.all([
      processDeploymentBatch(first.batch, queuedEnv),
      processDeploymentBatch(second.batch, queuedEnv),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.retry).not.toHaveBeenCalled();
    expect((await run(id)).ack).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'live' }]);
  });

  it('settles a canceled queued deployment without publishing it', async () => {
    const id = await admit();
    expect(await cancelDeployment(env.db, id)).toMatchObject({ status: 'canceling' });
    const message = await run(id);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'canceled' }]);
    expect(await env.ROUTING.get(`slug:${project.slug}`)).toBeNull();
    const operation = await getDeploymentOperation(env.db, id);
    expect(operation).toMatchObject({ status: 'terminal' });
    expect(operation?.events.at(-1)?.event).toMatchObject({
      event: 'error',
      step: expect.any(String),
    });
  });

  it('rejects a queued deployment after its durable project credential is revoked', async () => {
    const credentialId = 'credential_queued';
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await env.db.insert(projectDeployCredentials).values({
      id: credentialId,
      project_id: project.id,
      issued_by: user.id,
      name: 'queued test',
      expires_at: expiresAt.toISOString(),
    });
    const jwt = await signProjectCredentialToken(
      { credentialId, projectId: project.id, userId: user.id, login: user.login, expiresAt },
      env.JWT_SECRET,
    );
    const id = await admit(crypto.randomUUID(), jwt);
    expect((await getEvents(id, 0, jwt)).status).toBe(200);
    const otherOwnedProject = await createTestProject(env.db, user.id);
    expect((await getEvents(id, 0, jwt, otherOwnedProject.id)).status).toBe(403);
    await env.db
      .update(projectDeployCredentials)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(projectDeployCredentials.id, credentialId));
    const message = await run(id);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'failed' }]);
    expect(await env.ROUTING.get(`slug:${project.slug}`)).toBeNull();
    const operation = await getDeploymentOperation(env.db, id);
    expect(operation).toMatchObject({ status: 'terminal' });
    expect(operation?.events.at(-1)?.event).toMatchObject({
      event: 'error',
      step: expect.any(String),
    });
  });

  it('rejects a queued deployment whose bound build was revoked before execution', async () => {
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'deploying',
    });
    const jwt = await signDeployToken(
      { projectId: project.id, userId: user.id, login: user.login, buildId: build.id },
      env.JWT_SECRET,
    );
    const id = await admit(crypto.randomUUID(), jwt);
    expect(await getDeploymentOperation(env.db, id)).toMatchObject({ build_id: build.id });
    expect((await getEvents(id, 0, jwt)).status).toBe(200);
    await env.db.update(builds).set({ status: 'cancelled' }).where(eq(builds.id, build.id));
    const message = await run(id);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await env.db.select().from(deployments)).toMatchObject([{ id, status: 'failed' }]);
    expect(await env.ROUTING.get(`slug:${project.slug}`)).toBeNull();
    const operation = await getDeploymentOperation(env.db, id);
    expect(operation).toMatchObject({ status: 'terminal' });
    expect(operation?.events.at(-1)?.event).toMatchObject({
      event: 'error',
      step: expect.any(String),
    });
  });
});
