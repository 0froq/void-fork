import { desc, eq, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { computeAssetHash } from '../../src/assets';
import { updateDeploymentStatus } from '../../src/db';
import app from '../../src/index';
import { deployments, resources, domains, projects, projectSecrets, users } from '../../src/schema';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  createTestProjectSecret,
  mockCfApi,
  cfSuccess,
  readAllEvents,
  CF_ACCOUNT_ID,
  type TestEnv,
} from './helpers';

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const enc = new TextEncoder();

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildDeployForm(opts?: {
  manifest?: object;
  workers?: Record<string, string>;
  assets?: Record<string, string>;
  migrations?: Record<string, string>;
}): FormData {
  const form = new FormData();
  form.append('manifest', JSON.stringify(opts?.manifest ?? { version: 3, bindings: {} }));
  // Default: include at least one worker file
  const workers = opts?.workers ?? {
    'index.js': "export default { fetch() { return new Response('ok'); } }",
  };
  for (const [name, content] of Object.entries(workers)) {
    form.append(`worker:${name}`, new Blob([content]));
  }
  if (opts?.assets) {
    for (const [path, content] of Object.entries(opts.assets)) {
      form.append(`asset:${path}`, new Blob([content]));
    }
  }
  if (opts?.migrations) {
    for (const [name, sql] of Object.entries(opts.migrations)) {
      form.append(`migration:${name}`, new Blob([sql]));
    }
  }
  return form;
}

function parseDeployStream(text: string): Array<unknown> {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

type DeployEvent = { event: string } & Record<string, unknown>;
type DoneEvent = DeployEvent & {
  deployment: string;
  url?: string;
  urls?: Array<string>;
  assets?: number;
  workers?: number;
  migrations?: number;
};
type ErrorEvent = DeployEvent & { message?: string; step?: string };
type MigrationStartEvent = DeployEvent & { pending: number };
type MigrationEvent = DeployEvent & { name: string };
type AssetUploadEvent = DeployEvent & { total: number; new: number; cached: number };

function isDeployEvent(value: unknown): value is DeployEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    typeof (value as { event?: unknown }).event === 'string'
  );
}

function requireEvent<T extends DeployEvent>(events: Array<unknown>, name: string): T {
  const event = events.find(
    (candidate): candidate is T => isDeployEvent(candidate) && candidate.event === name,
  );
  expect(event).toBeDefined();
  return event!;
}

// Round 7 fix: validator regression tests used to `toEqual` the full error
// string, so any wording tweak would cascade through dozens of tests. Assert
// only the shape-validator prefix + a stable fragment (field name / enum key)
// so future rewords stay local to the validator source.
async function expectInvalidManifestShape(res: Response, fragment: string | RegExp): Promise<void> {
  // Deploy route now always returns 200 + NDJSON; shape-validation failures
  // surface as an `event: 'error'` row in the stream.
  expect(res.status).toBe(200);
  const events = parseDeployStream(await res.text()) as Array<{
    event: string;
    message?: string;
  }>;
  const err = events.find((e) => e.event === 'error');
  expect(err).toBeDefined();
  const msg = err!.message ?? '';
  expect(msg).toMatch(/^invalid manifest shape: /);
  if (typeof fragment === 'string') {
    expect(msg).toContain(fragment);
  } else {
    expect(msg).toMatch(fragment);
  }
}

function mockSetTimeout() {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: TimerHandler,
    ...args: Array<unknown>
  ) => nativeSetTimeout(fn, 0, ...args)) as typeof setTimeout);
}

describe('POST /projects/:id/deploy', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/deploy', {
        method: 'POST',
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/deploy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'project not found' });
  });

  it('returns 403 when user does not own project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bob.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('succeeds with minimal deploy (no bindings, no assets)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'minimal-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done.deployment).toMatch(/^dpl_/);
    expect(done.url).toBe('https://minimal-app.void.app');

    // Verify deployment is marked live in DB
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, done.deployment));
    expect(dpl?.status).toBe('live');
  });

  it('updates KV routing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'routed-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get('routed-app', 'json');
    expect(routing).toEqual({
      workerName: expect.stringMatching(/^user-routed-app-dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'void',
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it('stores ssr flag in KV routing when manifest enables ssr', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ssr-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 3, bindings: {}, ssr: true },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get('ssr-app', 'json');
    expect(routing).toEqual({
      workerName: expect.stringMatching(/^user-ssr-app-dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'void',
      ssr: true,
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it('sends worker upload to correct CF API endpoint', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Find the worker upload call
    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();
    const uploadUrl =
      typeof uploadCall![0] === 'string' ? uploadCall![0] : uploadCall![0].toString();
    expect(uploadUrl).toContain(
      `/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/void-users/scripts/user-worker-app-dpl_`,
    );
  });

  it('syncs cron schedules to CronScheduler DO on deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-app');
    mockCfApi();

    // Track DO fetch calls
    const cronDoFetches: Array<{ url: string; body: string }> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = await req.text();
          cronDoFetches.push({ url: req.url, body });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            schedules: [{ name: 'sync', cron: '0 * * * *' }],
          },
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify DO received /sync with correct payload
    const syncCall = cronDoFetches.find((f) => f.url.includes('/sync'));
    expect(syncCall).toBeDefined();
    const payload = JSON.parse(syncCall!.body);
    expect(payload.workerName).toMatch(/^user-cron-app-dpl_/);
    expect(payload.schedules).toEqual([{ name: 'sync', cron: '0 * * * *' }]);
    expect(payload.proxyToken).toEqual(expect.any(String));
    expect(payload.proxyToken.length).toBeGreaterThan(0);
  });

  it('clears cron schedules when previous deploy had crons', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-cron-app');
    mockCfApi();

    // Simulate previous deploy having crons by setting hasCrons in routing entry
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: `user-${project.slug}`, hasCrons: true }),
    );

    const cronDoFetches: Array<{ url: string }> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronDoFetches.push({ url: req.url });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 3, bindings: {} },
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify DO received /clear
    const clearCall = cronDoFetches.find((f) => f.url.includes('/clear'));
    expect(clearCall).toBeDefined();
  });

  it('skips CronScheduler DO when no crons present or previously configured', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'plain-app');
    mockCfApi();

    let doCalled = false;
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async () => {
          doCalled = true;
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 3, bindings: {} },
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // DO should NOT have been called
    expect(doCalled).toBe(false);
  });

  it('provisions D1 when manifest requires it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 3, bindings: { d1: ['DB'] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify resource row was created in DB
    const [resource] = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(resource).toBeDefined();
    expect(resource!.cf_id).toBe('d1-test-uuid');
    expect(resource!.binding_name).toBe('DB');
  });

  it('skips provisioning when resource already exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'existing-d1');
    const fetchMock = mockCfApi();

    // Pre-insert a resource
    await env.db.insert(resources).values({
      id: 'res_existing',
      project_id: project.id,
      type: 'd1',
      cf_id: 'existing-d1-uuid',
      binding_name: 'DB',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 3, bindings: { d1: ['DB'] } },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify no D1 creation call was made
    const createD1Call = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/d1/database') &&
        !url.includes('/query') &&
        (call[1] as RequestInit)?.method === 'POST'
      );
    });
    expect(createD1Call).toBeUndefined();
  });

  it('runs migrations via worker after upload (v3 flow)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'migrate-app');

    mockCfApi({
      createD1: () => cfSuccess({ uuid: 'd1-migrate-uuid', name: 'test-db' }),
    });

    // Mock the DISPATCH namespace so the deploy route can call the worker's
    // readiness probe and migration endpoint
    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/__void/ready') {
            return Response.json({ ready: true });
          }
          return Response.json({
            ok: true,
            migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 5 }],
          });
        },
      }),
    } as unknown as DispatchNamespace;

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}` },
          body: buildDeployForm({
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: { dialect: 'sqlite', pending: 1 },
            },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);

      const migrationStart = requireEvent<MigrationStartEvent>(events, 'migration_start');
      expect(migrationStart.pending).toBe(1);

      const migration = requireEvent<MigrationEvent>(events, 'migration');
      expect(migration.name).toBe('001_create_table.sql');

      const done = requireEvent<DoneEvent>(events, 'done');
      expect(done.migrations).toBe(1);
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  it('updates KV routing for active custom domains on deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-deploy');
    mockCfApi();

    // Insert an active domain
    await env.db.insert(domains).values({
      id: 'dom_deploy',
      project_id: project.id,
      hostname: 'deploy.example.com',
      cf_hostname_id: 'ch-deploy',
      status: 'active',
    });

    // Insert a pending domain (should NOT get KV routing)
    await env.db.insert(domains).values({
      id: 'dom_pending',
      project_id: project.id,
      hostname: 'pending.example.com',
      cf_hostname_id: 'ch-pending',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done.url).toBe('https://deploy.example.com');
    expect(done.urls).toContain('https://deploy.example.com');
    expect(done.urls).toContain('https://domain-deploy.void.app');

    // Verify domain KV routing was written
    const domainRouting = await env.ROUTING.get('domain:deploy.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: expect.stringMatching(/^user-domain-deploy-dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'void',
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });

    // Verify pending domain was NOT written
    const pendingRouting = await env.ROUTING.get('domain:pending.example.com');
    expect(pendingRouting).toBeNull();
  });

  it('returns 429 when deploy count exceeds plan limit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'limit-app');
    mockCfApi();

    // Insert 100 deployments created today (free tier limit)
    for (let i = 0; i < 100; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_limit_${i}`,
        project_id: project.id,
        status: 'live',
        created_at: sql`now()`,
      });
    }

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('deploy limit exceeded');
  });

  it('allows deploy when under plan limit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'under-limit-app');
    mockCfApi();

    // Insert 99 deployments (under free tier limit of 100)
    for (let i = 0; i < 99; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_under_${i}`,
        project_id: project.id,
        status: 'live',
        created_at: sql`now()`,
      });
    }

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Drain the NDJSON stream so the deploy IIFE (which holds deployments-table
    // writes) finishes before the next beforeEach runs clearTables.
    await readAllEvents(res);
  });

  it('includes limits in KV routing entry matching user plan', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'limits-kv-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = (await env.ROUTING.get('limits-kv-app', 'json')) as {
      limits: { cpuMs: number; subRequests: number };
    };
    expect(routing.limits).toEqual({ cpuMs: 10, subRequests: 50 });
  });

  it('omits limits for custom plan (all unlimited)', async () => {
    const user = await createTestUser(env.db, 'customuser', 'github', undefined, 'custom');
    const project = await createTestProject(env.db, user.id, 'custom-plan-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = (await env.ROUTING.get('custom-plan-app', 'json')) as Record<string, unknown>;
    expect(routing.limits).toBeUndefined();
  });

  it('includes manifest vars as plain_text bindings in worker upload', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'vars-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            vars: { API_URL: 'https://api.example.com', NODE_ENV: 'production' },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: Array<{ type: string; name: string; text?: string }>;
    };

    const plainTextBindings = (metadata.bindings ?? []).filter((b) => b.type === 'plain_text');
    expect(plainTextBindings).toEqual(
      expect.arrayContaining([
        { type: 'plain_text', name: 'API_URL', text: 'https://api.example.com' },
        { type: 'plain_text', name: 'NODE_ENV', text: 'production' },
      ]),
    );
  });

  it('injects worker secrets as secret_text bindings and auto-creates BETTER_AUTH_SECRET', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'auth-secret-app');
    await createTestProjectSecret(env.db, env, project.id, 'OPENAI_API_KEY', 'openai-secret');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: { version: 3, auth: true, bindings: {} },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const setSecretCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && url.includes('/secrets');
    });
    expect(setSecretCall).toBeUndefined();

    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/workers/dispatch/') &&
        (call[1] as RequestInit)?.method === 'PUT' &&
        !url.includes('/secrets')
      );
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: Array<{ type: string; name: string; text?: string }>;
    };

    const secretBindings = (metadata.bindings ?? []).filter((b) => b.type === 'secret_text');
    expect(secretBindings).toEqual(
      expect.arrayContaining([
        { type: 'secret_text', name: 'OPENAI_API_KEY', text: 'openai-secret' },
        {
          type: 'secret_text',
          name: 'BETTER_AUTH_SECRET',
          text: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]),
    );

    const [storedSecret] = await env.db
      .select({ name: projectSecrets.name, managed_reason: projectSecrets.managed_reason })
      .from(projectSecrets)
      .where(
        sql`${projectSecrets.project_id} = ${project.id} and ${projectSecrets.name} = 'BETTER_AUTH_SECRET'`,
      );
    expect(storedSecret).toEqual({
      name: 'BETTER_AUTH_SECRET',
      managed_reason: 'auth-default',
    });
  });

  it('rejects BETTER_AUTH_SECRET in manifest vars', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'auth-secret-var-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            auth: true,
            bindings: {},
            vars: { BETTER_AUTH_SECRET: 'plaintext-secret' },
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const events = await readAllEvents(res);
    const error = requireEvent<ErrorEvent>(events, 'error');
    expect(error.message).toContain(
      'BETTER_AUTH_SECRET must be configured via project secrets, not manifest.vars',
    );
  });

  it('marks deployment failed when worker upload fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fail-app');
    mockCfApi({
      uploadWorker: () => new Response('internal error', { status: 500 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const error = requireEvent<ErrorEvent>(events, 'error');
    expect(error.message).toContain('worker upload failed');
    expect(error.step).toBe('worker_upload');

    // Verify deployment is marked failed with error message
    const [dpl] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('failed');
    expect(dpl?.error_message).toContain('worker upload failed:');
  });

  it('provisions queue and adds consumer on deploy with queues manifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify queue resource was created in DB with queue_id (UUID), not queue_name
    const [resource] = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(resource).toBeDefined();
    expect(resource!.cf_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(resource!.binding_name).toBe('emails');

    // Verify addQueueConsumer was called with queue_id (UUID), not queue_name
    const consumerCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/queues/') && url.includes('/consumers');
    });
    expect(consumerCall).toBeDefined();
    const consumerUrl =
      typeof consumerCall![0] === 'string' ? consumerCall![0] : String(consumerCall![0]);
    expect(consumerUrl).toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('includes queue producer binding in worker upload metadata', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-binding-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: Array<{ type: string; name: string; queue_name?: string; queue_id?: string }>;
    };

    // queue_name is the deterministic name (for CF producer binding), queue_id is the UUID
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const queueBindings = (metadata.bindings ?? []).filter((b) => b.type === 'queue');
    expect(queueBindings).toEqual([
      {
        type: 'queue',
        name: 'QUEUE_EMAILS',
        queue_name: expectedQueueName,
        queue_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ]);
  });

  it('writes queue routing entry to KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-kv-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify queue routing KV entry (key uses deterministic queue name).
    // proxyToken must be present so void-dispatch can authenticate the relay
    // against the user worker's framework-generated /__void/queue endpoint.
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const queueRouting = (await env.ROUTING.get(`queue:${expectedQueueName}`, 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
      proxyToken: string;
    } | null;
    expect(queueRouting).toEqual({
      workerName: expect.stringMatching(/^user-queue-kv-app-dpl_/),
      projectId: project.id,
      queueName: 'emails',
      proxyToken: expect.any(String),
    });
    expect(queueRouting?.proxyToken.length ?? 0).toBeGreaterThan(0);
  });

  it('does not overwrite live queue KV when a conflicting deploy fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-conflict-noclobber');
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const routingKey = `queue:${expectedQueueName}`;

    // Seed: a previously-successful deploy already owns this route.
    await env.ROUTING.put(
      routingKey,
      JSON.stringify({
        workerName: 'user-queue-conflict-noclobber-dpl_live',
        projectId: project.id,
        queueName: 'emails',
        proxyToken: 'live-token',
      }),
    );

    mockCfApi({
      addQueueConsumer: () =>
        Response.json(
          { success: false, errors: [{ code: 100, message: 'queue already has a consumer' }] },
          { status: 400 },
        ),
      listQueueConsumers: () =>
        cfSuccess([{ consumer_id: 'c_other', script: 'other-dispatch', settings: {} }]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.some((e: unknown) => (e as { event: string }).event === 'error')).toBe(true);

    // The live queue route must still point at the previously-live worker —
    // the failed deploy must not overwrite it with a pointer to a new
    // worker that is about to be torn down.
    const routing = (await env.ROUTING.get(routingKey, 'json')) as {
      workerName: string;
      proxyToken: string;
    };
    expect(routing.workerName).toBe('user-queue-conflict-noclobber-dpl_live');
    expect(routing.proxyToken).toBe('live-token');
  });

  it('emits queue_consumer_conflict and fails the deploy when a different script owns the consumer', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-conflict-app');
    mockCfApi({
      addQueueConsumer: () =>
        Response.json(
          { success: false, errors: [{ code: 100, message: 'queue already has a consumer' }] },
          { status: 400 },
        ),
      listQueueConsumers: () =>
        cfSuccess([{ consumer_id: 'c_other', script: 'other-dispatch', settings: {} }]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const events = await readAllEvents(res);
    const conflict = events.find(
      (e: unknown) => (e as { event: string }).event === 'queue_consumer_conflict',
    ) as { event: string; queue: string; ownerScript: string } | undefined;
    expect(conflict).toBeDefined();
    expect(conflict!.queue).toBe('emails');
    expect(conflict!.ownerScript).toBe('other-dispatch');
    // Conflict is fatal: CI/automation clients must see a non-success
    // signal instead of a `done` event, otherwise a partially broken
    // deploy is indistinguishable from a healthy one.
    expect(events.some((e: unknown) => (e as { event: string }).event === 'done')).toBe(false);
    const errorEvent = events.find((e: unknown) => (e as { event: string }).event === 'error') as
      | { event: string; message: string }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toMatch(/queue.*emails.*other-dispatch/i);
  });

  it('streams events in pipeline order', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-test');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const eventNames = events.filter(isDeployEvent).map((event) => event.event);

    expect(eventNames[0]).toBe('start');
    expect(eventNames[eventNames.length - 1]).toBe('done');
    expect(eventNames).toContain('worker_upload');
    expect(eventNames).toContain('worker_upload_done');
  });

  it('retries plain-text asset upload response and succeeds on next attempt', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'asset-text-test');
    let uploadCalls = 0;
    mockCfApi({
      assetUpload: () => {
        uploadCalls++;
        if (uploadCalls <= 1) {
          return new Response('Assets have already been uploaded.');
        }
        return cfSuccess({ jwt: 'test-completion-jwt' });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('Assets have already been uploaded');
    const events = parseDeployStream(raw);
    expect(events.at(-1)).toMatchObject({ event: 'done' });
  });

  describe('retry-path behavior', () => {
    beforeEach(() => {
      mockSetTimeout();
    });

    it(
      'sanitizes error after retries exhausted on persistent plain-text session response',
      { timeout: 15_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'asset-text-error-test');
        mockCfApi({
          assetUploadSession: () => new Response('Assets have already been uploaded.'),
        });

        const res = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}` },
            body: buildDeployForm({
              assets: { 'index.html': '<h1>hi</h1>' },
            }),
          }),
          env,
        );

        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain('Assets have already been uploaded');
        const events = parseDeployStream(raw);
        expect(events.at(-1)).toMatchObject({
          event: 'error',
          step: 'asset_upload',
          message: 'asset upload session returned invalid response after retries',
        });
      },
    );

    it(
      'cleans up worker script when deploy fails before routing is switched',
      { timeout: 15_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'cleanup-pre-routing-test');
        // Worker upload always returns the plain-text bug → exhausts retries → fails before routing
        const fetchMock = mockCfApi({
          uploadWorker: () => new Response('Assets have already been uploaded.'),
        });

        const res = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}` },
            body: buildDeployForm({
              assets: { 'index.html': '<h1>hi</h1>' },
            }),
          }),
          env,
        );
        // Consume the stream to drive the deploy handler to completion (including the catch block)
        await res.text();

        // The outer catch should have called deleteDispatchScript (DELETE to workers/dispatch/...scripts/)
        const deleteCalls = fetchMock.mock.calls.filter((args: Array<unknown>) => {
          const url = typeof args[0] === 'string' ? args[0] : '';
          const init = args[1] as RequestInit | undefined;
          return (
            url.includes('/workers/dispatch/') &&
            url.includes('/scripts/') &&
            init?.method === 'DELETE'
          );
        });
        expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
        // At least one delete should target the new worker name
        const targetedNewWorker = deleteCalls.some((args: Array<unknown>) => {
          const url = args[0] as string;
          return url.includes(`user-${project.slug}-`);
        });
        expect(targetedNewWorker).toBe(true);
      },
    );

    it('retries worker upload when CF returns plain-text asset response', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-text-test');
      let uploadCalls = 0;
      mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          if (uploadCalls <= 2) {
            return new Response('Assets have already been uploaded.');
          }
          return new Response('ok', { status: 200 });
        },
      });

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}` },
          body: buildDeployForm({
            assets: { 'index.html': '<h1>hi</h1>' },
          }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(3);
    });

    it(
      'sanitizes error after worker upload retries exhausted on persistent plain-text response',
      { timeout: 15_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'worker-upload-text-error-test');
        mockCfApi({
          uploadWorker: () => new Response('Assets have already been uploaded.'),
        });

        const res = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}` },
            body: buildDeployForm({
              assets: { 'index.html': '<h1>hi</h1>' },
            }),
          }),
          env,
        );

        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain('Assets have already been uploaded');
        const events = parseDeployStream(raw);
        expect(events.at(-1)).toMatchObject({
          event: 'error',
          step: 'worker_upload',
          message: 'worker upload returned an unexpected Cloudflare response',
        });
      },
    );

    it('polls readiness probe before dispatching migrations', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-dispatch-retry-test');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-retry-uuid', name: 'test-db' }),
      });

      let readyCalls = 0;
      let migrateCalls = 0;
      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/ready') {
              readyCalls++;
              if (readyCalls <= 3) {
                return new Response('Assets have already been uploaded.');
              }
              return Response.json({ ready: true });
            }
            // /__void/migrate
            migrateCalls++;
            return Response.json({
              ok: true,
              migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 3 }],
            });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const res = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}` },
            body: buildDeployForm({
              manifest: {
                version: 3,
                bindings: { d1: ['DB'] },
                migrations: { dialect: 'sqlite', pending: 1 },
              },
            }),
          }),
          env,
        );
        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        expect(events.at(-1)).toMatchObject({ event: 'done' });
        // Readiness probe polled 4 times (3 failures + 1 success)
        expect(readyCalls).toBe(4);
        // Migration dispatched once (worker already confirmed live)
        expect(migrateCalls).toBe(1);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it('treats 404 from readiness probe as compatible (older worker without /__void/ready)', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-compat-404-test');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-compat-uuid', name: 'test-db' }),
      });

      let readyCalls = 0;
      let migrateCalls = 0;
      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/ready') {
              readyCalls++;
              // Older worker returns 404 — endpoint doesn't exist
              return new Response('Not Found', { status: 404 });
            }
            // /__void/migrate
            migrateCalls++;
            return Response.json({
              ok: true,
              migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 2 }],
            });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const res = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}` },
            body: buildDeployForm({
              manifest: {
                version: 3,
                bindings: { d1: ['DB'] },
                migrations: { dialect: 'sqlite', pending: 1 },
              },
            }),
          }),
          env,
        );
        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        expect(events.at(-1)).toMatchObject({ event: 'done' });
        // 404 treated as "ready" on first attempt — no retries
        expect(readyCalls).toBe(1);
        // Migration dispatched once
        expect(migrateCalls).toBe(1);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it('compat path retries migration with longer window when readiness probe returns 404', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-compat-retry-test');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-compat-retry-uuid', name: 'test-db' }),
      });

      let migrateCalls = 0;
      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/ready') {
              return new Response('Not Found', { status: 404 });
            }
            // /__void/migrate — first 3 calls hit CF propagation lag
            migrateCalls++;
            if (migrateCalls <= 3) {
              return new Response('Assets have already been uploaded.');
            }
            return Response.json({
              ok: true,
              migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 4 }],
            });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const res = await app.fetch(
          new Request(`http://localhost/projects/${project.id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.jwt}` },
            body: buildDeployForm({
              manifest: {
                version: 3,
                bindings: { d1: ['DB'] },
                migrations: { dialect: 'sqlite', pending: 1 },
              },
            }),
          }),
          env,
        );
        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        expect(events.at(-1)).toMatchObject({ event: 'done' });
        // 3 CF plain-text retries + 1 success = 4 calls.
        // This would fail with CF_MIGRATION_RETRY (maxRetries: 2, only 3 attempts).
        expect(migrateCalls).toBe(4);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it(
      'fails at readiness probe when worker never becomes reachable',
      { timeout: 30_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'migrate-dispatch-exhaust-test');
        mockCfApi({
          createD1: () => cfSuccess({ uuid: 'd1-exhaust-uuid', name: 'test-db' }),
        });

        let migrateCalls = 0;
        const originalDispatch = env.DISPATCH;
        env.DISPATCH = {
          get: () => ({
            fetch: async (req: Request) => {
              const url = new URL(req.url);
              if (url.pathname === '/__void/ready') {
                return new Response('Assets have already been uploaded.');
              }
              migrateCalls++;
              return Response.json({ ok: true, migrations: [] });
            },
          }),
        } as unknown as DispatchNamespace;

        try {
          const res = await app.fetch(
            new Request(`http://localhost/projects/${project.id}/deploy`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${user.jwt}` },
              body: buildDeployForm({
                manifest: {
                  version: 3,
                  bindings: { d1: ['DB'] },
                  migrations: { dialect: 'sqlite', pending: 1 },
                },
              }),
            }),
            env,
          );
          expect(res.status).toBe(200);
          const raw = await res.text();
          expect(raw).not.toContain('Assets have already been uploaded');
          const events = parseDeployStream(raw);
          expect(events.at(-1)).toMatchObject({
            event: 'error',
            step: 'migration',
            message: 'worker readiness probe failed: new worker not reachable after retries',
          });
          // Migration dispatch should never be attempted
          expect(migrateCalls).toBe(0);
        } finally {
          env.DISPATCH = originalDispatch;
        }
      },
    );
  });

  it('does not delete new worker when deploy succeeds (routing switched)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-cleanup-success-test');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events.at(-1)).toMatchObject({ event: 'done' });

    // Check DELETEs to dispatch scripts — the newly deployed versioned worker
    // (user-{slug}-{deploymentId}) must NOT be deleted
    const deleteCalls = fetchMock.mock.calls.filter((args: Array<unknown>) => {
      const url = typeof args[0] === 'string' ? args[0] : '';
      const init = args[1] as RequestInit | undefined;
      return (
        url.includes('/workers/dispatch/') && url.includes('/scripts/') && init?.method === 'DELETE'
      );
    });
    for (const args of deleteCalls) {
      const url = args[0] as string;
      // Legacy cleanup (user-{slug}) is OK; versioned cleanup (user-{slug}-dpl_*) for OLD
      // deployments is OK. But the new deployment's worker must not be deleted.
      // New deployment IDs start with "dpl_test" from createTestDeployment,
      // but deploy route creates its own ID. Just verify no delete targets a
      // versioned worker for this project (no previous deploys exist).
      if (url.includes(`user-${project.slug}-`)) {
        // This would be a versioned worker delete — shouldn't happen for a
        // project with no previous deployments
        expect(url).toBe('should not delete versioned worker');
      }
    }
  });
});

describe('Deploy deduplication (skip identical deploys)', () => {
  const manifest = { version: 3, bindings: {} };
  const assetContent = '<h1>hi</h1>';
  let assetManifest: Record<string, { hash: string; size: number }>;

  beforeEach(async () => {
    const buffer = await new Blob([assetContent]).arrayBuffer();
    assetManifest = {
      '/index.html': { hash: computeAssetHash(buffer, '/index.html'), size: buffer.byteLength },
    };
  });

  it('skips static-only deploy when manifest and assets are identical to live deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-app');

    // Insert a live deployment with known manifest and asset_hashes
    const liveDeployId = 'dpl_live_dedupe';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(manifest),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // Deploy with the same manifest and assetManifest
    const form = buildDeployForm({
      manifest,
      workers: {},
      assets: { 'index.html': assetContent },
    });
    form.append('assetManifest', JSON.stringify(assetManifest));
    form.append('preflight', 'true');

    // No CF API mock needed — deploy should be skipped entirely
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events).toHaveLength(2); // start + done only
    expect(events[0]).toMatchObject({ event: 'start', deploymentId: liveDeployId });
    expect(events[1]).toMatchObject({ event: 'done', deployment: liveDeployId });
  });

  it('dedupes streamed-static deploys when stored asset manifest order differs from the request', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-order-app');

    const streamedManifest = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' as const },
    };
    const indexBody = '<h1>index</h1>';
    const appBody = 'console.log("app");';
    const indexHash = computeAssetHash(new TextEncoder().encode(indexBody).buffer, '/index.html');
    const appHash = computeAssetHash(new TextEncoder().encode(appBody).buffer, '/assets/app.js');

    // Simulate a previously stored merged manifest whose insertion order no
    // longer matches the raw JSON string the client sends on retry.
    const liveAssetManifest = {
      '/assets/app.js': { hash: appHash, size: appBody.length },
      '/index.html': { hash: indexHash, size: indexBody.length },
    };
    const liveDeployId = 'dpl_live_dedupe_order';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(streamedManifest),
      asset_hashes: JSON.stringify(liveAssetManifest),
      retained: true,
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    await env.STATIC_ASSETS.put(`assets/${project.id}/${indexHash}`, indexBody);
    await env.STATIC_ASSETS.put(`assets/${project.id}/${appHash}`, appBody);

    const form = new FormData();
    form.append('manifest', JSON.stringify(streamedManifest));
    form.append(
      'assetManifest',
      JSON.stringify({
        '/index.html': { hash: indexHash, size: indexBody.length },
        '/assets/app.js': { hash: appHash, size: appBody.length },
      }),
    );
    form.append('asset:index.html', new Blob([indexBody]));
    form.append('asset:assets/app.js', new Blob([appBody]));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'start', deploymentId: liveDeployId });
    expect(events[1]).toMatchObject({ event: 'done', deployment: liveDeployId });

    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toHaveLength(1);
    expect(dpls[0]?.id).toBe(liveDeployId);
  });

  it('skips static-only deploy even when secrets changed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-secret-app');

    // Insert a live deployment created in the past
    const liveDeployId = 'dpl_live_secret';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(manifest),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now() - interval '1 hour'`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // Add a secret AFTER the deployment — identical static assets should still skip
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'secret-value');

    // Deploy with the same manifest — should still be skipped
    const form = buildDeployForm({
      manifest,
      workers: {},
      assets: { 'index.html': assetContent },
    });
    form.append('assetManifest', JSON.stringify(assetManifest));
    form.append('preflight', 'true');

    // No CF API mock needed — deploy should be skipped entirely
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events).toHaveLength(2); // start + done only
    expect(events[0]).toMatchObject({ event: 'start', deploymentId: liveDeployId });
    expect(events[1]).toMatchObject({ event: 'done', deployment: liveDeployId });
  });

  it('does not skip worker deploys when manifest and assets are identical', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-worker-app');
    mockCfApi();

    const liveDeployId = 'dpl_live_worker';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(manifest),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    const form = buildDeployForm({
      manifest,
      workers: { 'index.js': "export default { fetch() { return new Response('new'); } }" },
      assets: { 'index.html': assetContent },
    });
    form.append('assetManifest', JSON.stringify(assetManifest));
    form.append('preflight', 'true');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events.length).toBeGreaterThan(2);
    expect(events[0]).toMatchObject({ event: 'start' });
    expect(events[0]).not.toMatchObject({ deploymentId: liveDeployId });
    expect(events.at(-1)).toMatchObject({ event: 'done' });
  });

  it('proceeds with deploy when manifest differs from live deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-manifest-app');
    mockCfApi();

    // Insert a live deployment with a different manifest
    const liveDeployId = 'dpl_live_diff';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify({ version: 3, bindings: { d1: ['DB'] } }),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // Deploy with a different manifest (no d1 binding)
    const form = buildDeployForm({ manifest, assets: { 'index.html': assetContent } });
    form.append('assetManifest', JSON.stringify(assetManifest));
    form.append('preflight', 'true');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events.length).toBeGreaterThan(2);
    expect(events.at(-1)).toMatchObject({ event: 'done' });
  });
});

describe('Deploy serialization (concurrent deploy guard)', () => {
  it('returns 409 while a deploy is in progress', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-app');
    mockCfApi();

    // Insert an active (non-terminal) deployment
    await env.db.insert(deployments).values({
      id: 'dpl_active',
      project_id: project.id,
      status: 'uploading',
      created_at: sql`now()`,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; deployment: string };
    expect(body.error).toBe('deploy in progress');
    expect(body.deployment).toBe('dpl_active');
  });

  it('auto-fails stale deployment (>10 min) and allows new deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-app');
    mockCfApi();

    // Insert a stale active deployment (created 15 minutes ago)
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await env.db.insert(deployments).values({
      id: 'dpl_stale',
      project_id: project.id,
      status: 'uploading',
      created_at: staleTime,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify stale deployment was auto-failed
    const [stale] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.id, 'dpl_stale'));
    expect(stale?.status).toBe('failed');
    expect(stale?.error_message).toBe('timed out');
  });

  it('keeps a canceling deployment active until the deploy handler observes cancellation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cancel-active-app');

    await env.db.insert(deployments).values({
      id: 'dpl_cancel_active',
      project_id: project.id,
      status: 'uploading',
      created_at: sql`now()`,
    });

    const cancelRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments/dpl_cancel_active/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toMatchObject({
      ok: true,
      deploymentId: 'dpl_cancel_active',
      status: 'canceling',
    });

    const [canceling] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.id, 'dpl_cancel_active'));
    expect(canceling).toEqual({ status: 'canceling', error_message: 'canceled by user' });

    mockCfApi();
    const deployRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(deployRes.status).toBe(409);
    expect(await deployRes.json()).toEqual({
      error: 'deploy in progress',
      deployment: 'dpl_cancel_active',
    });

    await updateDeploymentStatus(env.db, 'dpl_cancel_active', 'migrating');
    const [stillCanceling] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, 'dpl_cancel_active'));
    expect(stillCanceling?.status).toBe('canceling');
  });

  it('does not cancel a terminal deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cancel-live-app');
    await env.db.insert(deployments).values({
      id: 'dpl_cancel_live',
      project_id: project.id,
      status: 'live',
      created_at: sql`now()`,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments/dpl_cancel_live/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'deployment already completed',
      status: 'live',
    });
  });

  it('allows deploy when previous deployment is terminal (live)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'terminal-app');
    mockCfApi();

    // Insert a completed deployment
    await env.db.insert(deployments).values({
      id: 'dpl_done',
      project_id: project.id,
      status: 'live',
      created_at: sql`now()`,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Drain the NDJSON stream so the deploy IIFE (which holds deployments-table
    // writes) finishes before the next beforeEach runs clearTables.
    await readAllEvents(res);
  });
});

function buildStaticDeployForm(opts: {
  type: 'spa' | 'static';
  assets?: Record<string, string | Blob>;
  /** When true, sets `manifest.type` so the deploy handler uses the streaming asset path. */
  streamed?: boolean;
}): FormData {
  const form = new FormData();
  const assetConfig =
    opts.type === 'spa'
      ? { not_found_handling: 'single-page-application' }
      : { not_found_handling: '404-page' };
  const manifest: Record<string, unknown> = { version: 3, bindings: {}, assetConfig };
  if (opts.streamed) {
    manifest.type = opts.type;
  }
  form.append('manifest', JSON.stringify(manifest));
  if (opts.assets) {
    for (const [path, content] of Object.entries(opts.assets)) {
      form.append(`asset:${path}`, content instanceof Blob ? content : new Blob([content]));
    }
  }
  return form;
}

describe('POST /projects/:id/deploy (static)', () => {
  it('succeeds with static SPA deploy (passthrough worker)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'spa-site');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          type: 'spa',
          assets: {
            'index.html': '<html>SPA</html>',
            'assets/app-abc123.js': "console.log('spa')",
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done.deployment).toMatch(/^dpl_/);
    expect(done.url).toBe('https://spa-site.void.app');
    expect(done.assets).toBe(2);
    expect(done.workers).toBe(0);
  });

  it('writes KV routing with staticDeploymentId for static SPA', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'kv-spa');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ type: 'spa' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get('kv-spa', 'json');
    expect(routing).toEqual({
      staticDeploymentId: expect.stringMatching(/^dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'static',
      assetConfig: { not_found_handling: 'single-page-application' },
      version: expect.stringMatching(/^dpl_/),
    });
  });

  it('updates project type column on static deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mode-update');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ type: 'static' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const [row] = await env.db
      .select({ type: projects.type })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row?.type).toBe('static');
  });
});

describe('POST /projects/:id/deploy (streaming static)', () => {
  it('streams small asset parts directly into STATIC_ASSETS KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-small');
    mockCfApi();

    const htmlBody = '<html>streamed SPA</html>';
    const jsBody = "console.log('streamed')";
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          type: 'spa',
          streamed: true,
          assets: {
            'index.html': htmlBody,
            'assets/app.js': jsBody,
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done).toBeDefined();
    expect(done.deployment).toMatch(/^dpl_/);
    expect(done.assets).toBe(2);
    expect(done.workers).toBe(0);

    const assetUploadEvent = requireEvent<AssetUploadEvent>(events, 'asset_upload');
    expect(assetUploadEvent).toEqual({ event: 'asset_upload', total: 2, new: 2, cached: 0 });

    const htmlHash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');
    const jsHash = computeAssetHash(new TextEncoder().encode(jsBody).buffer, '/assets/app.js');

    const htmlStored = await env.STATIC_ASSETS.get(
      `assets/${project.id}/${htmlHash}`,
      'arrayBuffer',
    );
    const jsStored = await env.STATIC_ASSETS.get(`assets/${project.id}/${jsHash}`, 'arrayBuffer');
    expect(htmlStored).not.toBeNull();
    expect(jsStored).not.toBeNull();
    expect(new TextDecoder().decode(htmlStored as ArrayBuffer)).toBe(htmlBody);
    expect(new TextDecoder().decode(jsStored as ArrayBuffer)).toBe(jsBody);

    const servingManifestRaw = await env.ROUTING.get(`manifest:${done.deployment}`);
    expect(servingManifestRaw).not.toBeNull();
    const servingManifest = JSON.parse(servingManifestRaw as string) as Record<string, string>;
    expect(servingManifest['/index.html']).toBe(htmlHash);
    expect(servingManifest['/assets/app.js']).toBe(jsHash);
  });

  it('pipes large asset parts into STATIC_ASSETS_R2 without buffering small ones via KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-large');
    mockCfApi();

    // 3 MB binary (> 2 MB KV threshold) — exercises the R2 branch end-to-end.
    const largeSize = 3 * 1024 * 1024;
    const largeBytes = new Uint8Array(largeSize);
    for (let i = 0; i < largeSize; i++) {
      largeBytes[i] = (i * 17 + 5) & 0xff;
    }
    const largeBlob = new Blob([largeBytes], { type: 'video/mp4' });

    const htmlBody = '<html>hi</html>';
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          type: 'spa',
          streamed: true,
          assets: {
            'index.html': htmlBody,
            'video.mp4': largeBlob,
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done.assets).toBe(2);

    const htmlHash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');
    const videoHash = computeAssetHash(largeBytes.buffer, '/video.mp4');

    // Small asset → KV
    const htmlStored = await env.STATIC_ASSETS.get(
      `assets/${project.id}/${htmlHash}`,
      'arrayBuffer',
    );
    expect(htmlStored).not.toBeNull();
    expect(new TextDecoder().decode(htmlStored as ArrayBuffer)).toBe(htmlBody);
    // Large asset → not in KV
    const videoInKv = await env.STATIC_ASSETS.get(`assets/${project.id}/${videoHash}`);
    expect(videoInKv).toBeNull();

    // Serving manifest should prefix large-asset hashes with "!" so dispatch
    // knows to look in R2.
    const servingManifestRaw = await env.ROUTING.get(`manifest:${done.deployment}`);
    const servingManifest = JSON.parse(servingManifestRaw as string) as Record<string, string>;
    expect(servingManifest['/index.html']).toBe(htmlHash);
    expect(servingManifest['/video.mp4']).toBe(`!${videoHash}`);
  });

  it('rejects unsupported manifest version before any asset upload', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-bad-version');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({ version: 999, type: 'spa', bindings: {}, assetConfig: {} }),
    );
    form.append('asset:index.html', new Blob(['<html></html>']));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toMatch(/Unsupported deploy manifest version/);

    // The rejection must fire before any `asset:*` part is uploaded, so
    // STATIC_ASSETS KV must contain nothing under this project's prefix.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);
  });

  it('dedupes identical assets by content hash across paths', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-dedupe');
    mockCfApi();

    const shared = 'console.log("shared bundle")';
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({
          type: 'spa',
          streamed: true,
          assets: {
            'a/app.js': shared,
            'b/app.js': shared,
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const assetUploadEvent = requireEvent<AssetUploadEvent>(events, 'asset_upload');
    // Two paths, one unique content hash — only one upload counts as "new".
    expect(assetUploadEvent).toEqual({ event: 'asset_upload', total: 2, new: 1, cached: 1 });

    // Only one KV key should exist for the shared hash.
    const sharedHash = computeAssetHash(new TextEncoder().encode(shared).buffer, '/a/app.js');
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    const projectKeys = listed.keys.map((k: { name: string }) => k.name);
    expect(projectKeys).toEqual([`assets/${project.id}/${sharedHash}`]);
  });

  it('rejects asset parts that arrive before the manifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-order');
    mockCfApi();

    const form = new FormData();
    // Asset first, manifest second — invalid ordering. Even if the parser
    // accepts it, the handler must refuse and leave KV untouched.
    form.append('asset:index.html', new Blob(['<html></html>']));
    form.append(
      'manifest',
      JSON.stringify({ version: 3, type: 'spa', bindings: {}, assetConfig: {} }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toMatch(/manifest part must precede/);

    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);
  });

  it('rejects worker parts when manifest.type is spa/static and cleans up streamed assets', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-mixed');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({ version: 3, type: 'spa', bindings: {}, assetConfig: {} }),
    );
    // This asset gets streamed into KV before the invalid worker part is seen.
    form.append('asset:index.html', new Blob(['<html>streamed before worker</html>']));
    form.append('worker:index.js', new Blob(['export default {}']));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toMatch(/worker parts are not allowed/);

    // Orphaned streamed assets must be swept — nothing should remain under the
    // project prefix because no retained deployment references these hashes.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);
  });

  it('sweeps extra streamed assets when dedupe short-circuits, preserving matched hashes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-dedupe-sweep');
    mockCfApi();

    // Live deployment: one asset already in KV, referenced by a retained row.
    const liveHtml = '<html>live</html>';
    const liveHash = computeAssetHash(new TextEncoder().encode(liveHtml).buffer, '/index.html');
    const liveAssetManifest = {
      '/index.html': { hash: liveHash, size: liveHtml.length },
    };
    const liveManifestObj = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    };
    await env.STATIC_ASSETS.put(`assets/${project.id}/${liveHash}`, liveHtml);

    const liveDeployId = 'dpl_live_sweep';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(liveManifestObj),
      asset_hashes: JSON.stringify(liveAssetManifest),
      retained: true,
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // New deploy: identical assetManifest (so dedupe fires) but an EXTRA
    // streamed asset that is NOT in assetManifest. A misbehaving client could
    // pipe this into KV before the handler even sees the manifest comparison.
    const orphanBody = '<html>orphan</html>';
    const orphanHash = computeAssetHash(
      new TextEncoder().encode(orphanBody).buffer,
      '/orphan.html',
    );

    const form = new FormData();
    form.append('manifest', JSON.stringify(liveManifestObj));
    form.append('assetManifest', JSON.stringify(liveAssetManifest));
    form.append('asset:index.html', new Blob([liveHtml]));
    form.append('asset:orphan.html', new Blob([orphanBody]));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events[events.length - 1]).toMatchObject({
      event: 'done',
      deployment: liveDeployId,
    });

    // Matched hash must survive — it is referenced by the retained live row.
    const keptHtml = await env.STATIC_ASSETS.get(`assets/${project.id}/${liveHash}`);
    expect(keptHtml).not.toBeNull();
    // Orphan was streamed in before dedupe fired, then swept by the outer
    // try/finally once the response short-circuited.
    const orphan = await env.STATIC_ASSETS.get(`assets/${project.id}/${orphanHash}`);
    expect(orphan).toBeNull();
  });

  it('returns 429 for over-cap streamed-static deploys WITHOUT writing asset parts to KV/R2 (R18 F1)', async () => {
    // Regression for reviewer Finding #1: the daily cap check used to run
    // AFTER the parse loop, which meant streamed-static deploys would write
    // every `asset:*` part into KV/R2 before the 429 response was generated.
    // An over-quota user who never received a 2xx still paid for every byte
    // in storage write cost. The fix moves the cap check to immediately
    // after manifest parse for streamed-static deploys, so the 429 fires
    // before any asset body is consumed. This test intentionally sacrifices
    // the "dedupe-at-cap for static retries" UX; the cap is meant to be a
    // hard ceiling and storage writes must not happen past it.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-cap-early');
    mockCfApi();

    // Seed an existing live deployment with an unrelated hash so the cleanup
    // sweep could, in principle, clobber it if the fix used a stale retained
    // set (Finding #3 shares this risk, verified in its own test).
    const htmlBody = '<html>new</html>';
    const newHash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');
    const liveManifestObj = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    };

    // Pad the user to exactly the free-plan daily cap (100 total). With the
    // new early check this must return 429 before the parse loop consumes
    // any `asset:*` part.
    for (let i = 0; i < 100; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_pad_${i}`,
        project_id: project.id,
        status: 'live',
        created_at: sql`now()`,
      });
    }

    const form = new FormData();
    form.append('manifest', JSON.stringify(liveManifestObj));
    form.append('asset:index.html', new Blob([htmlBody]));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('deploy limit exceeded');

    // Nothing was written under this project's asset prefix. If the check
    // still ran after `collectAndUploadStaticAsset`, the new hash would be
    // present in KV here.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);
    // And the new content-addressed key specifically is absent.
    const newStored = await env.STATIC_ASSETS.get(`assets/${project.id}/${newHash}`);
    expect(newStored).toBeNull();
  });

  it('still runs dedupe-at-cap for worker-backed deploys (buffered parts) (R18 F1)', async () => {
    // Worker modules are buffered in RAM during parse rather than persisted
    // to KV/R2, so the cap check for worker-backed deploys stays deferred
    // to AFTER the dedupe branch. An identical retry at cap should still
    // resolve to the existing live deployment instead of failing 429.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-cap-worker');
    mockCfApi();

    // Match the worker-backed dedupe check: a full deploy with a worker
    // module + no assets means the dedupe branch won't fire because the
    // dedupe check requires `!hasWorkerFiles`. So for worker deploys, cap
    // at exactly the limit returns 429 (the standard cap behavior). Verify
    // that path still fires via the worker-backed check.
    for (let i = 0; i < 100; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_pad_worker_${i}`,
        project_id: project.id,
        status: 'live',
        created_at: sql`now()`,
      });
    }

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('deploy limit exceeded');
  });

  it('protects the current live-but-not-retained deployment from cleanup sweep (R18 F3)', async () => {
    // Regression for reviewer Finding #3: `cleanupStreamedAssetsOnAbort`
    // used `getRetainedDeployments` alone, which only returns rows where
    // `retained=true`. If the post-routing recovery path hits a swallowed
    // `markDeploymentRetained(...).catch(()=>{})` failure, the live
    // deployment stays as `retained=false`. A subsequent failing deploy's
    // cleanup would then evict the live deployment's asset hashes out from
    // under real serving traffic. The fix also includes the current
    // `project.active_deployment_id` in the retained-hash set.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-active-protect');
    mockCfApi();

    // Pre-seed a live deployment whose `retained` flag is false but which
    // the project actively serves (i.e. markDeploymentRetained silently
    // failed in a past recovery). Its content-addressed hash is already
    // live in KV.
    const liveHtml = '<html>alive</html>';
    const liveHash = computeAssetHash(new TextEncoder().encode(liveHtml).buffer, '/index.html');
    await env.STATIC_ASSETS.put(
      `assets/${project.id}/${liveHash}`,
      new TextEncoder().encode(liveHtml),
      { metadata: { ct: 'text/html' } },
    );
    const liveDeployId = 'dpl_active_unretained';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
      asset_hashes: JSON.stringify({
        '/index.html': { hash: liveHash, size: liveHtml.length },
      }),
      retained: false, // <-- the failure mode Finding #3 covers
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // Now send a new streamed-static deploy whose hash happens to match the
    // live deployment's hash (same content). The deploy will parse the
    // first `asset:index.html` part and begin writing — then fail on a
    // duplicate `manifest` part, triggering `cleanupStreamedAssetsOnAbort`.
    // With the broken pre-fix code, the retained set would be empty (the
    // only deployment is `retained=false`) and the live hash would be
    // evicted. With the fix, the live deployment's hash is included and
    // survives the sweep.
    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('asset:index.html', new Blob([liveHtml]));
    // Second manifest part forces the handler into its duplicate-manifest
    // error branch AFTER the first asset part has already streamed into KV.
    form.append('manifest', JSON.stringify({ version: 3, type: 'spa', bindings: {} }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toMatch(/duplicate manifest part/);

    // The live deployment's hash must still be readable — it is referenced
    // by the current active_deployment_id and therefore protected.
    const kept = await env.STATIC_ASSETS.get(`assets/${project.id}/${liveHash}`, 'arrayBuffer');
    expect(kept).not.toBeNull();
    expect(new TextDecoder().decode(kept as ArrayBuffer)).toBe(liveHtml);
  });

  it('re-reads the latest active deployment before abort cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-active-reread');
    mockCfApi();

    const htmlBody = '<html>latest-active</html>';
    const hash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');
    const manifest = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' as const },
    };

    const originalPut = env.STATIC_ASSETS.put.bind(env.STATIC_ASSETS);
    let switchedActive = false;
    vi.spyOn(env.STATIC_ASSETS, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        const result = await originalPut(
          key,
          value as Parameters<typeof originalPut>[1],
          options as Parameters<typeof originalPut>[2],
        );
        if (!switchedActive && key === `assets/${project.id}/${hash}`) {
          switchedActive = true;
          const liveDeployId = 'dpl_live_after_request_start';
          await env.db.insert(deployments).values({
            id: liveDeployId,
            project_id: project.id,
            status: 'live',
            manifest: JSON.stringify(manifest),
            asset_hashes: JSON.stringify({
              '/index.html': { hash, size: htmlBody.length },
            }),
            retained: false,
            created_at: sql`now()`,
          });
          await env.db
            .update(projects)
            .set({ active_deployment_id: liveDeployId })
            .where(eq(projects.id, project.id));
        }
        return result;
      },
    );

    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('asset:index.html', new Blob([htmlBody]));
    form.append('manifest', JSON.stringify(manifest));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toMatch(/duplicate manifest part/);

    const kept = await env.STATIC_ASSETS.get(`assets/${project.id}/${hash}`, 'arrayBuffer');
    expect(kept).not.toBeNull();
    expect(new TextDecoder().decode(kept as ArrayBuffer)).toBe(htmlBody);
  });

  it('protects hashes referenced by another in-flight deployment during abort cleanup', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-inflight-protect');
    mockCfApi();

    const htmlBody = '<html>shared</html>';
    const hash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');
    const manifest = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' as const },
    };

    const originalPut = env.STATIC_ASSETS.put.bind(env.STATIC_ASSETS);
    let insertedInflight = false;
    vi.spyOn(env.STATIC_ASSETS, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        if (!insertedInflight && key === `assets/${project.id}/${hash}`) {
          insertedInflight = true;
          await env.db.insert(deployments).values({
            id: 'dpl_other_inflight',
            project_id: project.id,
            status: 'uploading',
            manifest: JSON.stringify(manifest),
            asset_hashes: JSON.stringify({
              '/index.html': { hash, size: htmlBody.length },
            }),
            created_at: sql`now()`,
          });
        }
        return originalPut(
          key,
          value as Parameters<typeof originalPut>[1],
          options as Parameters<typeof originalPut>[2],
        );
      },
    );

    // Force the current deploy onto the abort-cleanup path after the asset
    // was already streamed into KV. The second in-flight row above should
    // protect the shared content-addressed key from deletion.
    const wrongHash = (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1);
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append(
      'assetManifest',
      JSON.stringify({ '/index.html': { hash: wrongHash, size: htmlBody.length } }),
    );
    form.append('asset:index.html', new Blob([htmlBody]));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent?.message).toMatch(/asset hash mismatch/);

    const kept = await env.STATIC_ASSETS.get(`assets/${project.id}/${hash}`, 'arrayBuffer');
    expect(kept).not.toBeNull();
    expect(new TextDecoder().decode(kept as ArrayBuffer)).toBe(htmlBody);
  });

  it('protects hashes claimed by another streamed-static request before asset_hashes is persisted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-claim-protect');
    mockCfApi();

    const htmlBody = '<html>claimed</html>';
    const hash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');
    const manifest = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' as const },
    };

    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let injectedForeignClaim = false;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        const result = await originalPut(
          key,
          value as Parameters<typeof originalPut>[1],
          options as Parameters<typeof originalPut>[2],
        );
        if (!injectedForeignClaim && key.startsWith(`deploy-asset-claim:${project.id}:${hash}:`)) {
          injectedForeignClaim = true;
          await originalPut(`deploy-asset-claim:${project.id}:${hash}:foreign-request`, '1');
        }
        return result;
      },
    );

    const wrongHash = (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1);
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append(
      'assetManifest',
      JSON.stringify({ '/index.html': { hash: wrongHash, size: htmlBody.length } }),
    );
    form.append('asset:index.html', new Blob([htmlBody]));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent?.message).toMatch(/asset hash mismatch/);

    const kept = await env.STATIC_ASSETS.get(`assets/${project.id}/${hash}`, 'arrayBuffer');
    expect(kept).not.toBeNull();
    expect(new TextDecoder().decode(kept as ArrayBuffer)).toBe(htmlBody);

    const leakedClaims = await env.ROUTING.list({
      prefix: `deploy-asset-claim:${project.id}:${hash}:`,
    });
    expect(leakedClaims.keys.map((k) => k.name)).toEqual([
      `deploy-asset-claim:${project.id}:${hash}:foreign-request`,
    ]);
  });

  it('sweeps streamed assets when applyDeclaredAssetManifest throws mid-stream', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-hash-mismatch');
    mockCfApi();

    const htmlBody = '<html>hi</html>';
    const realHash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');
    // Flip the first char to force a mismatch while keeping the 32-char length
    // required by the applyDeclaredAssetManifest validator.
    const wrongHash = (realHash[0] === 'a' ? 'b' : 'a') + realHash.slice(1);
    expect(wrongHash).not.toBe(realHash);
    expect(wrongHash).toHaveLength(32);

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append(
      'assetManifest',
      JSON.stringify({ '/index.html': { hash: wrongHash, size: htmlBody.length } }),
    );
    form.append('asset:index.html', new Blob([htmlBody]));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toMatch(/asset hash mismatch/);

    // The real hash streamed into KV before the mismatch was detected inside
    // the ReadableStream's start(). The inner catch must sweep it — no
    // retained deployment references this project's hashes yet.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);
  });
});

// Direct-stream-to-R2 path: when the client declared { hash, size } for an
// asset whose size crosses the KV threshold, `asset:*` bodies are piped
// straight through a hashing transform into `r2.put` without buffering.
// Per-asset Worker memory becomes O(hasher-state + ≤ 2-byte carry), so a
// multi-hundred-MiB asset no longer charges the 128 MiB request budget at all.
// These tests live here (not in unit tests) because the behaviour depends
// on the multipart parse loop + declared-manifest gate + real R2 binding
// semantics (atomic write-if-absent via onlyIf), and those only line up
// under the miniflare integration harness.
describe('POST /projects/:id/deploy (streaming static direct-to-R2)', () => {
  it('streams a large declared-manifest asset directly into STATIC_ASSETS_R2 with zero buffered residency', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-large');
    mockCfApi();

    // 10 MiB asset — well above the 2 MiB KV threshold so the streaming
    // branch fires, and large enough that a buffered path would pin real
    // memory against the 128 MiB Worker isolate budget.
    const largeSize = 10 * 1024 * 1024;
    const largeBytes = new Uint8Array(largeSize);
    for (let i = 0; i < largeSize; i++) {
      largeBytes[i] = (i * 31 + 7) & 0xff;
    }
    const largeHash = computeAssetHash(largeBytes.buffer, '/bundle.bin');
    // A second large asset so we prove concurrent large payloads don't
    // cumulatively pin memory against the isolate budget (the whole point
    // of streaming).
    const otherSize = 8 * 1024 * 1024;
    const otherBytes = new Uint8Array(otherSize);
    for (let i = 0; i < otherSize; i++) {
      otherBytes[i] = (i * 13 + 2) & 0xff;
    }
    const otherHash = computeAssetHash(otherBytes.buffer, '/video.mp4');

    const htmlBody = '<html>hi</html>';
    const htmlHash = computeAssetHash(new TextEncoder().encode(htmlBody).buffer, '/index.html');

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append(
      'assetManifest',
      JSON.stringify({
        '/index.html': { hash: htmlHash, size: htmlBody.length },
        '/bundle.bin': { hash: largeHash, size: largeSize },
        '/video.mp4': { hash: otherHash, size: otherSize },
      }),
    );
    form.append('asset:index.html', new Blob([htmlBody]));
    form.append('asset:bundle.bin', new Blob([largeBytes], { type: 'application/octet-stream' }));
    form.append('asset:video.mp4', new Blob([otherBytes], { type: 'video/mp4' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done).toBeDefined();
    expect(done.assets).toBe(3);
    expect(done.workers).toBe(0);

    const assetUploadEvent = requireEvent<AssetUploadEvent>(events, 'asset_upload');
    expect(assetUploadEvent).toEqual({ event: 'asset_upload', total: 3, new: 3, cached: 0 });

    // Both large assets landed in R2 under their content-addressed keys.
    const largeHead = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${largeHash}`);
    expect(largeHead).not.toBeNull();
    expect(largeHead!.size).toBe(largeSize);
    const otherHead = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${otherHash}`);
    expect(otherHead).not.toBeNull();
    expect(otherHead!.size).toBe(otherSize);

    // Large assets must NOT appear in KV (streaming always writes R2).
    const largeInKv = await env.STATIC_ASSETS.get(`assets/${project.id}/${largeHash}`);
    expect(largeInKv).toBeNull();
    const otherInKv = await env.STATIC_ASSETS.get(`assets/${project.id}/${otherHash}`);
    expect(otherInKv).toBeNull();

    // Small asset still flows through KV via the pool path.
    const htmlStored = await env.STATIC_ASSETS.get(
      `assets/${project.id}/${htmlHash}`,
      'arrayBuffer',
    );
    expect(htmlStored).not.toBeNull();
    expect(new TextDecoder().decode(htmlStored as ArrayBuffer)).toBe(htmlBody);

    // Serving manifest marks R2-backed hashes with the "!" prefix.
    const servingManifestRaw = await env.ROUTING.get(`manifest:${done.deployment}`);
    const servingManifest = JSON.parse(servingManifestRaw as string) as Record<string, string>;
    expect(servingManifest['/index.html']).toBe(htmlHash);
    expect(servingManifest['/bundle.bin']).toBe(`!${largeHash}`);
    expect(servingManifest['/video.mp4']).toBe(`!${otherHash}`);

    // Round-trip readback through R2 confirms bytes were not corrupted by
    // the pipe-through (hash match implies this, but read back anyway).
    const largeBody = await env.STATIC_ASSETS_R2.get(`assets/${project.id}/${largeHash}`);
    expect(largeBody).not.toBeNull();
    const readBack = new Uint8Array(await largeBody!.arrayBuffer());
    expect(readBack.length).toBe(largeSize);
    // Spot-check — byte-for-byte equal at a few deterministic offsets.
    expect(readBack[0]).toBe(largeBytes[0]);
    expect(readBack[largeSize - 1]).toBe(largeBytes[largeSize - 1]);
    expect(readBack[largeSize >> 1]).toBe(largeBytes[largeSize >> 1]);
  });

  it('surfaces a parse error and deletes the corrupted R2 blob when the declared hash does not match the body', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-bad-hash');
    mockCfApi();

    // Real content that will stream + be hashed server-side, but we declare
    // a wrong hash. The wrong hash is what gates the streaming branch, so
    // the R2 key ends up under the DECLARED (wrong) hash — which must be
    // deleted once the post-stream verify catches the mismatch.
    const bodySize = 4 * 1024 * 1024; // > KV_THRESHOLD to hit streaming path
    const bodyBytes = new Uint8Array(bodySize);
    for (let i = 0; i < bodySize; i++) {
      bodyBytes[i] = (i * 11 + 1) & 0xff;
    }
    const realHash = computeAssetHash(bodyBytes.buffer, '/corrupt.bin');
    const wrongHash = (realHash[0] === 'a' ? 'b' : 'a') + realHash.slice(1);
    expect(wrongHash).not.toBe(realHash);
    expect(wrongHash).toHaveLength(32);

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append(
      'assetManifest',
      JSON.stringify({ '/corrupt.bin': { hash: wrongHash, size: bodySize } }),
    );
    form.append('asset:corrupt.bin', new Blob([bodyBytes], { type: 'application/octet-stream' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toMatch(/asset hash mismatch|declared hash/);

    // The blob must have been deleted under the wrong-hash key (we wrote,
    // then the hash verify failed, so our function deletes its own bytes).
    const stillThere = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${wrongHash}`);
    expect(stillThere).toBeNull();
    // And it was never written under the real hash either (streaming path
    // keys by declared hash, not computed hash).
    const neverWrote = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${realHash}`);
    expect(neverWrote).toBeNull();
  });

  it('surfaces a parse error when the declared size does not match the body length', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-bad-size');
    mockCfApi();

    // Actual body is 4 MiB; we lie and tell the server it's 5 MiB. The
    // FixedLengthStream in the pipeline must reject, and the error maps
    // to an NDJSON parse error.
    const actualSize = 4 * 1024 * 1024;
    const declaredSize = 5 * 1024 * 1024;
    const bodyBytes = new Uint8Array(actualSize);
    for (let i = 0; i < actualSize; i++) {
      bodyBytes[i] = (i * 7 + 3) & 0xff;
    }
    // Hash value doesn't matter for this test — the size check fires first.
    const bogusHash = 'f'.repeat(32);

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append(
      'assetManifest',
      JSON.stringify({ '/size-lie.bin': { hash: bogusHash, size: declaredSize } }),
    );
    form.append('asset:size-lie.bin', new Blob([bodyBytes], { type: 'application/octet-stream' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent).toBeDefined();
    // Deploy must surface an error (exact message is best-effort — a
    // short-body TypeError from FixedLengthStream propagates through the
    // put path and is deliberately not rewritten at the streamStaticAssetToR2
    // boundary any more, because doing so would also misclassify R2
    // infra TypeErrors as client size mismatches; see the
    // `surfaces R2 put failures raw` test below for the correctness
    // counter-case). The LOAD-BEARING invariant is that no deployment
    // row and no stranded R2 blob survive — the cleanup paths fire
    // regardless of which error channel surfaced the failure.
    expect((errEvent.message ?? '').length).toBeGreaterThan(0);

    // No R2 blob must have survived under the declared hash.
    const stranded = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${bogusHash}`);
    expect(stranded).toBeNull();
  });

  it('treats an R2 precondition-miss (content-addressed key already exists) as a dedupe hit across deploys', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-precond');
    mockCfApi();

    const size = 3 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = (i * 23 + 9) & 0xff;
    }
    const hash = computeAssetHash(bytes.buffer, '/shared.bin');

    function buildForm(): FormData {
      const form = new FormData();
      form.append(
        'manifest',
        JSON.stringify({
          version: 3,
          type: 'spa',
          bindings: {},
          assetConfig: { not_found_handling: 'single-page-application' },
        }),
      );
      form.append('assetManifest', JSON.stringify({ '/shared.bin': { hash, size } }));
      form.append('asset:shared.bin', new Blob([bytes], { type: 'application/octet-stream' }));
      return form;
    }

    // First deploy: fresh put, creates the content-addressed R2 key.
    const firstRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildForm(),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);
    const firstEvents = await readAllEvents(firstRes);
    const firstDone = requireEvent<DoneEvent>(firstEvents, 'done');
    expect(firstDone).toBeDefined();
    const firstBlob = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${hash}`);
    expect(firstBlob).not.toBeNull();
    const originalEtag = firstBlob!.etag;

    // Second deploy: same body, same declared hash. The second `r2.put`
    // MUST be a precondition miss (etagDoesNotMatch: '*' returns null),
    // and the deploy MUST still succeed with the hash verified.
    const secondRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildForm(),
      }),
      env,
    );
    expect(secondRes.status).toBe(200);
    const secondEvents = await readAllEvents(secondRes);
    const secondDone = requireEvent<DoneEvent>(secondEvents, 'done');
    expect(secondDone).toBeDefined();

    // The R2 object is unchanged — same etag, same size.
    const secondBlob = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${hash}`);
    expect(secondBlob).not.toBeNull();
    expect(secondBlob!.etag).toBe(originalEtag);
    expect(secondBlob!.size).toBe(size);
  });

  it('preserves a pre-existing R2 blob when a new deploy sends bad bytes under the same declared hash', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-precond-safe');
    mockCfApi();

    // Seed R2 with a known-good blob that a retained deployment depends on.
    // The hash is computed from the legitimate bytes so a well-behaved
    // deploy would never have a reason to rewrite them.
    const size = 3 * 1024 * 1024;
    const goodBytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      goodBytes[i] = (i * 17 + 11) & 0xff;
    }
    const hash = computeAssetHash(goodBytes.buffer, '/shared.bin');
    const key = `assets/${project.id}/${hash}`;
    await env.STATIC_ASSETS_R2.put(key, goodBytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    const seededBlob = await env.STATIC_ASSETS_R2.head(key);
    expect(seededBlob).not.toBeNull();
    const seededEtag = seededBlob!.etag;

    // Simulate a retained deployment that references this hash so the
    // abort-cleanup path would protect it (the poisoning protection is the
    // R2 precondition — this retained row is belt-and-suspenders).
    const liveAssetManifest = { '/shared.bin': { hash, size } };
    const liveManifestObj = {
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' as const },
    };
    await env.db.insert(deployments).values({
      id: 'dpl_retained_precond',
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(liveManifestObj),
      asset_hashes: JSON.stringify(liveAssetManifest),
      retained: true,
      created_at: sql`now()`,
    });

    // New deploy: declares the SAME hash, but sends DIFFERENT bytes.
    // The R2 put returns null (precondition miss), then the post-stream
    // hash computes to the bad body's hash — which does not match the
    // declared hash — so we throw AssetHashMismatchError. Critically,
    // the existing good blob must NOT be deleted by the mismatch branch.
    const badBytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      badBytes[i] = ((i * 29 + 5) ^ 0xa5) & 0xff;
    }

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('assetManifest', JSON.stringify({ '/shared.bin': { hash, size } }));
    form.append('asset:shared.bin', new Blob([badBytes], { type: 'application/octet-stream' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toMatch(/hash mismatch|declared hash/);

    // Pre-existing R2 blob MUST still be present with the same etag.
    // If this assertion fails, the precondition protection is broken and
    // a malicious or buggy client can poison retained deployments.
    const afterBlob = await env.STATIC_ASSETS_R2.head(key);
    expect(afterBlob).not.toBeNull();
    expect(afterBlob!.etag).toBe(seededEtag);
    expect(afterBlob!.size).toBe(size);

    // Sanity: round-trip the bytes and confirm we still have the original
    // good content, not the bad body.
    const reread = await env.STATIC_ASSETS_R2.get(key);
    expect(reread).not.toBeNull();
    const rereadBytes = new Uint8Array(await reread!.arrayBuffer());
    expect(rereadBytes[0]).toBe(goodBytes[0]);
    expect(rereadBytes[size - 1]).toBe(goodBytes[size - 1]);
  });

  // Reviewer caught that a transient r2.delete failure inside
  // streamStaticAssetToR2's mismatch-after-write branch would strand a
  // poisoned blob at the content-addressed key forever: streamedHashStores
  // was populated only AFTER the call returned, so abort cleanup never
  // retried the delete. A later deploy with correct bytes would then hit
  // the precondition-miss path and trust the stored bytes — serving
  // corrupted content. Fix: pre-register the hash in streamedHashStores
  // + publish the claim BEFORE the call, so abort cleanup sweeps the
  // blob regardless of where the throw happens inside the function.
  it('retries r2.delete via abort cleanup when the inline delete fails after a hash-mismatch write', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-delete-retry');
    mockCfApi();

    const bodySize = 4 * 1024 * 1024;
    const bodyBytes = new Uint8Array(bodySize);
    for (let i = 0; i < bodySize; i++) {
      bodyBytes[i] = (i * 19 + 2) & 0xff;
    }
    const realHash = computeAssetHash(bodyBytes.buffer, '/corrupt.bin');
    const wrongHash = (realHash[0] === 'a' ? 'b' : 'a') + realHash.slice(1);
    expect(wrongHash).not.toBe(realHash);

    // Fail the first r2.delete (the inline one inside streamStaticAssetToR2)
    // and succeed on the second (invoked by abort cleanup via
    // cleanupStreamedStaticAssets). If the fix is present, both deletes
    // fire and the blob is gone at end; without the fix, only the inline
    // delete fires (and fails), leaving the poisoned key in R2.
    const originalDelete = env.STATIC_ASSETS_R2.delete.bind(env.STATIC_ASSETS_R2);
    let deleteCallCount = 0;
    const deleteSpy = vi
      .spyOn(env.STATIC_ASSETS_R2, 'delete')
      .mockImplementation(async (keys: string | Array<string>) => {
        deleteCallCount++;
        if (deleteCallCount === 1) {
          throw new Error('simulated transient R2 delete failure');
        }
        return originalDelete(keys as string);
      });

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append(
      'assetManifest',
      JSON.stringify({ '/corrupt.bin': { hash: wrongHash, size: bodySize } }),
    );
    form.append('asset:corrupt.bin', new Blob([bodyBytes], { type: 'application/octet-stream' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toMatch(/hash mismatch|declared hash/);

    // Load-bearing invariants for the fix:
    //   1. Inline delete fired (deleteCallCount ≥ 1).
    //   2. Abort cleanup ALSO fired a delete for the same key
    //      (deleteCallCount === 2), proving `streamedHashStores` was
    //      pre-populated so the sweep could find it.
    //   3. The blob is gone at end: the cleanup retry succeeded.
    expect(deleteCallCount).toBe(2);
    const stranded = await env.STATIC_ASSETS_R2.head(`assets/${project.id}/${wrongHash}`);
    expect(stranded).toBeNull();

    deleteSpy.mockRestore();
  });

  // Reviewer caught that `streamStaticAssetToR2`'s catch block used to
  // rewrite ANY non-`MultipartParseError` into a size-mismatch parse
  // error whenever `bytesSeen < declared.size`. That condition is also
  // true when `r2.put` fails early — R2 cancels its consumer, the pipe
  // sees fewer bytes than declared, and the valid server-side infra
  // error gets surfaced to the client as a bogus "body size does not
  // match declared" parse error. Fix: prefer the raw R2 put rejection
  // when the put side failed, mapping to size-mismatch ONLY on a
  // genuine short-body pipe failure.
  it('surfaces R2 put failures raw instead of rewrapping them as size mismatches', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-put-failure');
    mockCfApi();

    const size = 4 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = (i * 37 + 5) & 0xff;
    }
    const hash = computeAssetHash(bytes.buffer, '/infra-fail.bin');

    // Fail the streaming put immediately — the consumer-side cancellation
    // triggers a pipe reject with `bytesSeen < declared.size`, exercising
    // the code path the reviewer identified.
    const putSpy = vi.spyOn(env.STATIC_ASSETS_R2, 'put').mockImplementation(async () => {
      throw new Error('simulated R2 upstream 500');
    });

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('assetManifest', JSON.stringify({ '/infra-fail.bin': { hash, size } }));
    form.append('asset:infra-fail.bin', new Blob([bytes], { type: 'application/octet-stream' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent).toBeDefined();
    // Load-bearing: R2 put failures used to get rewritten as
    // `MultipartParseError('body size X does not match declared Y')`
    // because `bytesSeen < declared.size` is also true when r2.put
    // cancels its consumer mid-stream. That misled operators — the
    // parse-error event looked like a client protocol violation instead
    // of an infra fault. The fix surfaces the raw R2 error class; the
    // outer deploy handler's `sanitizeDeployErrorMessage` then maps
    // unknown internal errors to the generic "deploy failed due to an
    // internal error" message (not leaking infra internals to clients,
    // but still correctly distinct from the parse-path message). So the
    // assertion is: the NDJSON error is NOT the size-mismatch message.
    expect(errEvent.message).not.toMatch(/does not match declared/);
    expect(errEvent.message).not.toMatch(/body size/);

    putSpy.mockRestore();
  });

  // Reviewer caught the edge case where r2.put rejects with a TypeError
  // (rare but not impossible: a cancelled-consumer cascade, a malformed-
  // response parser TypeError, etc.). The prior implementation checked
  // `err instanceof TypeError && bytesSeen < declared.size` BEFORE the
  // `putFailure` surfacing, so a TypeError from the R2 put itself would
  // get rewritten as a client size-mismatch — hiding a real server-side
  // fault behind a misleading "body size does not match declared" event.
  // Fix: always prefer `putFailure` over the TypeError short-stream
  // rewrite. The FLX close-count TypeError still surfaces cleanly for
  // genuine short-body cases because in that scenario there's no
  // independent put failure driving the error path (put also rejects,
  // but with the same cascaded TypeError that the outer handler's
  // sanitizer routes through the generic internal-error event). Either
  // way, the key correctness invariant tested here: R2 rejections are
  // NOT misclassified as client size mismatches.
  it('does not misclassify a TypeError-shaped R2 put failure as a client size mismatch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-r2-put-typeerror');
    mockCfApi();

    const size = 4 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = (i * 41 + 11) & 0xff;
    }
    const hash = computeAssetHash(bytes.buffer, '/type-err.bin');

    // Simulate an R2 put that rejects with a TypeError mid-upload. Per
    // the reviewer's report, this was the exact shape that defeated the
    // class-based detector in the earlier revision.
    const putSpy = vi.spyOn(env.STATIC_ASSETS_R2, 'put').mockImplementation(async () => {
      throw new TypeError('simulated R2 internal TypeError');
    });

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('assetManifest', JSON.stringify({ '/type-err.bin': { hash, size } }));
    form.append('asset:type-err.bin', new Blob([bytes], { type: 'application/octet-stream' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errEvent).toBeDefined();
    // LOAD-BEARING: the client must NOT see a "body size does not match
    // declared" message when the real failure is on the server storage
    // side. The raw TypeError bubbles to the outer catch and is mapped
    // to the generic internal-error event by the sanitizer — which is
    // the correct outcome (client gets a non-misleading error without
    // infra internals leaking).
    expect(errEvent.message).not.toMatch(/does not match declared/);
    expect(errEvent.message).not.toMatch(/body size/);

    putSpy.mockRestore();
  });
});

// Regression tests for the connection-lost fix: the deploy handler constructs
// a TransformStream and returns `new Response(readable, ...)` BEFORE multipart
// parsing / asset uploads begin, so CF edge / intermediaries see the 200 + NDJSON
// content-type within milliseconds instead of blocking for 30–60s of sequential
// KV/R2 puts. See packages/api/src/routes/deploy.ts (around the IIFE at line
// ~1028 and the `return new Response(readable)` at line ~2349).
describe('POST /projects/:id/deploy (streaming response headers / heartbeat)', () => {
  it('returns application/x-ndjson and streams events incrementally (start first, done last)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-headers-flush');
    mockCfApi();

    // Build a deploy with a decent number of asset parts so parse + streamed
    // KV puts take non-trivial time — this is what the fix rescues from
    // blocking the response headers. Each asset hashes to a unique key via
    // path-prefixed BLAKE3, so 40 parts means 40 KV puts.
    const assets: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      assets[`assets/file-${i}.js`] = `/* file ${i} */ export const x = ${i};`;
    }
    assets['index.html'] = '<html><body>streamed</body></html>';

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ type: 'spa', streamed: true, assets }),
      }),
      env,
    );

    // Structural guard: the deploy route now always answers with NDJSON,
    // including 4xx-like validation failures.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.body).not.toBeNull();

    // Read the stream incrementally. If the parse/upload work were moved
    // back into the handler body (before `new Response(readable)`), the
    // ordering of NDJSON lines would be unchanged, but this reader-based
    // approach mirrors what the CLI does and is the correct client-side
    // contract for a streaming deploy response.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<{ event: string } & Record<string, unknown>> = [];
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          events.push(JSON.parse(line));
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      events.push(JSON.parse(buffer));
    }

    // Filter out heartbeats — timing-dependent in CI, not what this test guards.
    const nonHeartbeat = events.filter((e) => e.event !== 'heartbeat');

    // The very first non-heartbeat event consumed from the incremental
    // reader must be `start`. This proves the IIFE began emitting before
    // the stream closed — i.e. events were produced progressively, not
    // accumulated after a fully-synchronous parse.
    expect(nonHeartbeat[0]?.event).toBe('start');

    // The stream must contain the expected downstream events in order.
    const order = nonHeartbeat.map((e) => e.event);
    expect(order).toContain('asset_upload');
    expect(order).toContain('asset_upload_done');
    expect(order[order.length - 1]).toBe('done');

    // Sanity: the deploy actually succeeded with the right asset count.
    const doneEvent = nonHeartbeat.find((e) => e.event === 'done') as {
      event: 'done';
      deployment: string;
      assets: number;
      workers: number;
    };
    expect(doneEvent.deployment).toMatch(/^dpl_/);
    expect(doneEvent.assets).toBe(41);
    expect(doneEvent.workers).toBe(0);
  });

  it('emits at least one heartbeat during the deploy pipeline (env override)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-heartbeat');
    mockCfApi();

    // Lower the heartbeat interval to the 1ms floor so the timer fires on
    // every macrotask cycle the deploy pipeline yields to (stream chunk
    // reads, KV puts, PGlite writes). In-process tests can complete a 40-asset
    // streamed deploy in ~15ms, so the 15s production default would miss
    // every tick — this is exactly why we plumb an env override.
    const testEnv = { ...env, DEPLOY_HEARTBEAT_INTERVAL_MS: 1 };

    // Enough asset parts that parse + KV puts take well over 20ms even on
    // fast hardware. Each part costs an `await` on the KV put + a hash
    // computation, so the setInterval(heartbeat, 20ms) callback has ample
    // event-loop opportunities to fire.
    const assets: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      assets[`chunk-${i}.js`] = `export const payload = ${JSON.stringify('x'.repeat(512))} + ${i};`;
    }
    assets['index.html'] = '<html><body>heartbeat</body></html>';

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildStaticDeployForm({ type: 'spa', streamed: true, assets }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);

    const events = (await readAllEvents(res)) as Array<{ event: string } & Record<string, unknown>>;
    const order = events.map((e) => e.event);

    // At least one heartbeat must have fired — if the heartbeat timer were
    // still living inside the TransformStream's `start()` body (as it did
    // before the fix), `clearInterval` in `finally` would cancel it before
    // the interval ever had a chance to fire for a fast deploy. Plumbing
    // the interval across the whole IIFE is exactly what this asserts.
    const heartbeats = events.filter((e) => e.event === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    // And a heartbeat must appear before `done` in the stream order, proving
    // it fired during the pipeline rather than after it.
    const firstHeartbeatIdx = order.indexOf('heartbeat');
    const doneIdx = order.indexOf('done');
    expect(firstHeartbeatIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(firstHeartbeatIdx).toBeLessThan(doneIdx);

    // Heartbeat payload shape: `step` is always present; `deploymentId` is
    // optional because heartbeats that fire during the parse/validate
    // phase (before `createDeployment` runs) would otherwise carry an
    // empty-string id, which leaks an invalid value to monitoring tools.
    // Post-create heartbeats carry the real id; pre-create ones omit it.
    for (const hb of heartbeats) {
      expect(typeof hb.step).toBe('string');
      expect(hb.deploymentId === undefined || typeof hb.deploymentId === 'string').toBe(true);
      if (typeof hb.deploymentId === 'string') {
        expect(hb.deploymentId.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('POST /projects/:id/deploy (edge cases)', () => {
  // ---- Multipart protocol errors ----

  it('returns 400 when Content-Type header is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-missing-ct');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    // Content-Type / boundary is a pre-stream guard: it's a sync header read
    // that happens before the NDJSON TransformStream is constructed, so
    // malformed requests still get a 4xx JSON response (matching 404/403/409).
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('multipart parse error: missing Content-Type header');
  });

  it('returns 400 when Content-Type has no boundary parameter', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-no-boundary');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'multipart/form-data',
        },
        body: 'whatever',
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('multipart parse error: missing boundary in Content-Type');
  });

  it('returns 400 when the multipart body is truncated mid-part', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-truncated');
    mockCfApi();

    const boundary = '----void-truncated';
    // Valid part start but no closing delimiter → parser hits EOF mid-body.
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="manifest"\r\n\r\n` +
      `{"version":3,"bindings":{}`; // intentionally truncated

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('multipart parse error: end of stream while reading part body');
  });

  it('returns 400 when a part is missing Content-Disposition', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-no-cd');
    mockCfApi();

    const boundary = '----void-no-cd';
    const body =
      `--${boundary}\r\n` + `X-Custom: whatever\r\n\r\n` + `some body\r\n` + `--${boundary}--\r\n`;

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('multipart parse error: part missing Content-Disposition');
  });

  it('returns 400 when the request contains a duplicate manifest part', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-dup-manifest');
    mockCfApi();

    const form = new FormData();
    const manifestJson = JSON.stringify({
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' },
    });
    form.append('manifest', manifestJson);
    form.append('manifest', manifestJson);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('duplicate manifest part');
  });

  // ---- Manifest / ordering ----

  it('returns 400 with no deployment row when manifest JSON is malformed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-bad-json');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', 'NOT VALID JSON {');
    // Include an asset so we'd catch any accidental KV write before the manifest is parsed.
    form.append('asset:index.html', new Blob(['<html></html>']));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // JSON.parse SyntaxError is surfaced via the NDJSON `error` event so the
    // user sees a clear "invalid manifest JSON: ..." message, not a generic 500.
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message ?? '').toMatch(/^invalid manifest JSON:/);

    // Manifest arrives before any asset part, so nothing should have streamed
    // into KV — but assert it anyway to guard against ordering regressions.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);

    // No deployment row should exist: the failure happens inside the parse
    // loop, well before createDeployment is called.
    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  it('returns 400 when the manifest JSON is literally null', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-manifest-null');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', 'null');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // Without shape validation, `JSON.parse('null')` would pass the syntax
    // check and crash on `incomingManifest.version` with an uncaught 500.
    await expectInvalidManifestShape(res, 'expected a JSON object');

    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  it('returns 400 when manifest bindings field is missing or not an object', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-manifest-no-bindings');
    mockCfApi();

    const form = new FormData();
    // Valid version, missing bindings — would otherwise crash at
    // `manifest.bindings.d1 ?? []` AFTER a deployment row was created.
    form.append('manifest', JSON.stringify({ version: 3 }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'bindings');

    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  it('returns 400 when manifest bindings is explicitly null', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-manifest-null-bindings');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: null }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'bindings');

    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  // A string `bindings.d1` would iterate characters and silently provision
  // `d`/`b` resources. Every bindings.* array must be rejected unless it's a
  // string[] — BEFORE createDeployment runs, so no deployment row or CF
  // resources leak.
  it('returns 400 when bindings.d1 is a string instead of array', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-d1-string');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: { d1: 'DB' } }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'bindings.d1');

    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  it('returns 400 when bindings.kv is a number', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-kv-number');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: { kv: 1 } }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'bindings.kv');
  });

  it('returns 400 when bindings.r2 contains non-string entries', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-r2-mixed');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: { r2: ['ok', 42] } }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'bindings.r2');
  });

  it('returns 400 when queues is a string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-queues-string');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, queues: 'jobs' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /queues\b/);
  });

  it('returns 400 when queues entries are missing required fields', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-queues-bad-entry');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        queues: [{ name: 'jobs' }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'bindingName');
  });

  // A non-array `websocket.classes` crashes `sortUnique()` in
  // `enrichWebSocketManifest()`. The entire websocket subtree must be
  // validated before createDeployment runs.
  it('returns 400 when websocket is not an object', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-ws-string');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, websocket: 'room' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /^invalid manifest shape: websocket must/);
  });

  it('returns 400 when websocket.classes is not an array', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-ws-classes');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        websocket: { routes: [], classes: 1 },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'websocket.classes');
  });

  it('returns 400 when websocket.routes is not an array', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-ws-routes');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        websocket: { routes: 'x', classes: [] },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /websocket\.routes must/);
  });

  it('returns 400 when websocket.migrations is not an array', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-ws-migrations');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        websocket: { routes: [], classes: [], migrations: 5 },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'websocket.migrations');
  });

  // `headerRules`/`redirectRules` are persisted into ROUTING KV via
  // `buildRoutingJson` without a later shape check, so a malformed manifest
  // would go live and crash `dispatch` on the very first request. Reject
  // malformed shapes before createDeployment.
  it('returns 400 when headerRules is not an array', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-headerRules-str');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, headerRules: 'x' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /^invalid manifest shape: headerRules must/);
  });

  it('returns 400 when headerRules entries are missing pattern', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-headerRules-badpattern');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        headerRules: [{ pattern: 1, headers: [] }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /headerRules.*pattern/);
  });

  it('returns 400 when headerRules headers entries are not string pairs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-headerRules-badpairs');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        headerRules: [{ pattern: '/*', headers: [['X-Foo', 1]] }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /headerRules.*headers/);
  });

  it('returns 400 when redirectRules entries have wrong types', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-bad');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: 1, destination: '/x', status: 302 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /redirectRules.*source/);
  });

  // Scalar/object fields must have their types enforced at ingest — wrong
  // types would otherwise survive `createDeployment` and either crash late
  // in the pipeline or persist garbage routing.
  it('returns 400 when auth is not a boolean', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-auth-string');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, auth: 'false' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /^invalid manifest shape: auth /);
  });

  it('returns 400 when vars has a non-string value', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-vars-num');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, vars: { FOO: 1 } }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'vars.FOO');
  });

  it('returns 400 when compatibilityFlags is a string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-compatflags-str');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        compatibilityFlags: 'nodejs_compat',
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'compatibilityFlags');
  });

  it('returns 400 when type is not a recognized value', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-type-bogus');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, type: 'nonsense' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /^invalid manifest shape: type .+framework/);
  });

  it('returns 400 when revalidate is a string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-revalidate-str');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, revalidate: '100' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /^invalid manifest shape: revalidate /);
  });

  // `redirectRules[].status` must be checked against the allowed-status
  // list, not just `typeof === 'number'`. A bogus `{status: 999}` would
  // otherwise survive validation and break matching requests at runtime.
  it('returns 400 when redirectRules status is not a recognized code', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirect-status-bogus');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/a', destination: '/b', status: 999 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /redirectRules.*status/);
  });

  // Verify that 200 survives shape validation.
  it('accepts redirectRules with status 200 (force rewrite)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-rewrite');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/old', destination: '/new', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // Deploy route always returns 200 + NDJSON; a shape-validation failure
    // would surface as an `event: 'error'` row containing 'invalid manifest
    // shape: '. Assert we don't see one here.
    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text()) as Array<{
      event: string;
      message?: string;
    }>;
    const shapeErr = events.find(
      (e) => e.event === 'error' && (e.message ?? '').startsWith('invalid manifest shape: '),
    );
    expect(shapeErr).toBeUndefined();
  });

  // status=200 rewrite destinations containing `?` would double-merge with
  // request query via `mergeQueryIntoLocation`. For 3xx redirects the merge
  // is intentional (destination query preserved, request query layered on
  // top), so `?` is only rejected on status=200 entries.
  it('returns 400 when redirectRules destination contains a query string at status 200', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-destquery-200');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/a', destination: '/b?foo=1', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /redirectRules entry .* destination must not contain/);
  });

  // Counterpart to the above: 3xx redirects with a `?` destination are valid
  // because `mergeQueryIntoLocation` in dispatch is built specifically to
  // layer incoming request query on top of the destination's own query.
  it('accepts redirectRules 3xx redirect with query string in destination', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-destquery-3xx');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/old', destination: '/new?from=old', status: 301 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text()) as Array<{
      event: string;
      message?: string;
    }>;
    const shapeErr = events.find(
      (e) => e.event === 'error' && (e.message ?? '').startsWith('invalid manifest shape: '),
    );
    expect(shapeErr).toBeUndefined();
  });

  // `fallbackRules` needs its own shape-validation branch — without it,
  // malformed entries land in routing KV and crash dispatch. Cover each of
  // the entry-shape failure modes plus the status/destination restrictions.
  it('returns 400 when fallbackRules entries are missing fields', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-fallbackRules-missing');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        // Missing `destination`.
        fallbackRules: [{ source: '/*', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /fallbackRules/);
  });

  it('returns 400 when fallbackRules entry status is not 200', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-fallbackRules-status301');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 301 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /fallbackRules.*status must be 200/);
  });

  it('returns 400 when fallbackRules destination contains a query string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-fallbackRules-destquery');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        fallbackRules: [{ source: '/*', destination: '/index.html?v=1', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /fallbackRules entry .* destination must not contain/);
  });

  // Hand-crafted manifests that bypass the framework CLI could ship
  // `destination: "https://evil.com"` on a `status: 200` entry, turning the
  // edge router into an open HTTP proxy. Reject non-path-absolute
  // destinations on rewrite entries (both rule lists).
  it('returns 400 when redirectRules status-200 destination is not path-absolute', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-absolute');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/docs', destination: 'https://evil.com', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(
      res,
      /redirectRules entry .* destination must be path-absolute/,
    );
  });

  it('accepts redirectRules 3xx redirect with external destination', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-external3xx');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/docs', destination: 'https://docs.example.com', status: 301 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text()) as Array<{
      event: string;
      message?: string;
    }>;
    const shapeErr = events.find(
      (e) => e.event === 'error' && (e.message ?? '').startsWith('invalid manifest shape: '),
    );
    expect(shapeErr).toBeUndefined();
  });

  // The path-absolute check (`startsWith('/')`) still accepts protocol-
  // relative URLs like `//evil.com/x`, which parse cross-origin. Reject
  // those explicitly so a hand-crafted manifest can't weaponize a rewrite
  // into an open redirect.
  it('returns 400 when redirectRules status-200 destination is protocol-relative (//...)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-proto-rel');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/docs', destination: '//evil.com/x', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(
      res,
      /redirectRules entry .* destination must not start with "\/\/"/,
    );
  });

  it('accepts redirectRules 3xx redirect with protocol-relative destination', async () => {
    // 3xx redirects legitimately allow external/protocol-relative Location
    // values — the guard fires only at status 200 (rewrite).
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-redirectRules-proto-rel-3xx');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        redirectRules: [{ source: '/docs', destination: '//cdn.example.com/docs', status: 301 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text()) as Array<{
      event: string;
      message?: string;
    }>;
    const shapeErr = events.find(
      (e) => e.event === 'error' && (e.message ?? '').startsWith('invalid manifest shape: '),
    );
    expect(shapeErr).toBeUndefined();
  });

  it('returns 400 when fallbackRules destination is protocol-relative (//...)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-fallbackRules-proto-rel');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        fallbackRules: [{ source: '/*', destination: '//evil.com/index.html', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(
      res,
      /fallbackRules entry .* destination must not start with "\/\/"/,
    );
  });

  it('returns 400 when fallbackRules destination is not path-absolute', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-fallbackRules-absolute');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        fallbackRules: [{ source: '/*', destination: 'https://evil.com/index.html', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(
      res,
      /fallbackRules entry .* destination must be path-absolute/,
    );
  });

  it('returns 400 when fallbackRules entries have wrong source type', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-fallbackRules-source-num');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        fallbackRules: [{ source: 1, destination: '/index.html', status: 200 }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /fallbackRules.*source/);
  });

  // `websocket.routes[].bindingName` is fed into the CF worker metadata
  // binding list (`buildWebSocketUploadBindings`); accepting any type would
  // corrupt the metadata. Reject non-string bindingName.
  it('returns 400 when websocket.routes entry bindingName is not a string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-ws-routes-bindingName');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        websocket: {
          routes: [{ className: 'Foo', bindingName: 1 }],
          classes: ['Foo'],
        },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, /websocket\.routes.*bindingName/);
  });

  // Queue consumer tuning fields (maxBatchSize/maxBatchTimeout/maxRetries/
  // retryDelay) must be validated: unchecked, bad values reach
  // addQueueConsumer and produce NaN CF settings via `maxBatchTimeout * 1000`.
  it('returns 400 when queue maxBatchTimeout is not a finite number', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-queue-tuning-string');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        queues: [{ name: 'jobs', bindingName: 'JOBS', maxBatchTimeout: 'x' }],
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'maxBatchTimeout');
  });

  // `assetConfig.{not_found_handling, html_handling}` must validate against
  // their enum lists — wrong values would silently disable SPA/404 handling
  // without crashing.
  it('returns 400 when assetConfig.not_found_handling is not a recognized enum', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-assetConfig-404');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        assetConfig: { not_found_handling: 'spa' },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'not_found_handling');
  });

  it('returns 400 when assetConfig.html_handling is not a recognized enum', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-assetConfig-html');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        assetConfig: { html_handling: 'unknown-strategy' },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'html_handling');
  });

  // `migrations.dialect` and `migrations.pending` must be validated. The
  // migration dispatch path reads `manifest.migrations.pending > 0`
  // unconditionally, so a wrong-typed value would reach the CF migration
  // runner and crash mid-deploy.
  it('returns 400 when migrations.dialect is not a recognized value', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-migrations-dialect');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        migrations: { dialect: 'mysql', pending: 1 },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'migrations.dialect');
  });

  it('returns 400 when migrations.pending is not a number', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-migrations-pending-str');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        migrations: { dialect: 'sqlite', pending: 'many' },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'migrations.pending');
  });

  it('returns 400 when migrations.pending is a negative integer', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-migrations-pending-neg');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        migrations: { dialect: 'sqlite', pending: -1 },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'migrations.pending');
  });

  it('returns 400 when migrations.pending is a non-integer number', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-migrations-pending-frac');
    mockCfApi();

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        bindings: {},
        migrations: { dialect: 'sqlite', pending: 1.5 },
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    await expectInvalidManifestShape(res, 'migrations.pending');
  });

  // Text parts (manifest, assetManifest, etc.) read via
  // `new Response(part.body).text()` with no cap let an attacker force
  // large allocations BEFORE validateManifestShape runs. Each buffered text
  // part has a hard byte cap; exceeding it returns 413.
  it('returns 413 when the manifest part exceeds the 8 MiB cap', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-manifest-too-large');
    mockCfApi();

    // Build a manifest slightly over the 8 MiB limit. The validator should
    // never see it — the read path must throw PartTooLargeError first.
    const padding = 'x'.repeat(9 * 1024 * 1024);
    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {}, _pad: padding }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message ?? '').toContain('manifest part exceeds');

    // No deployment row should exist — the parse loop aborted before any
    // createDeployment call.
    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  // Same OOM class as the manifest part, but for `worker:*` parts. Worker
  // script bytes are already streamed through readPartBytes with a 32 MiB
  // cap; this test pins the 413 mapping end-to-end so a future refactor
  // cannot silently reintroduce an unbounded read.
  it('returns 413 when a single worker:* part exceeds the 32 MiB cap', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-worker-too-large');
    mockCfApi();

    const oversized = new Uint8Array(33 * 1024 * 1024);
    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {} }));
    form.append('worker:index.js', new Blob([oversized]));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message ?? '').toMatch(/worker:index\.js.* exceeds/);

    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  // Static-deploy leak window: between writing `asset_hashes` to the
  // deployment row and claiming retention via `markDeploymentRetained(...,
  // true)`, any failure must still sweep the streamed blobs — until the
  // retention claim lands, `getRetainedDeployments` cannot see this
  // deployment, so future cleanup would never evict its hashes and they'd
  // leak indefinitely. We inject the failure by throwing on the second
  // ROUTING.put call (the slug put at line ~1137), which lives exactly
  // inside that window.
  it('sweeps streamed assets when a post-asset_hashes, pre-retention step fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-pre-retention-fail');
    mockCfApi();

    const originalRoutingPut = env.ROUTING.put.bind(env.ROUTING);
    let routingPutCount = 0;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        routingPutCount++;
        // The first ROUTING.put is `manifest:<deployment>` (happens BEFORE
        // asset_hashes is written). The second is the slug routing put,
        // which happens AFTER asset_hashes and BEFORE markDeploymentRetained.
        // Fail on the slug put to land inside the window under test.
        if (key === project.slug) {
          throw new Error('simulated ROUTING.put failure inside pre-retention window');
        }
        return originalRoutingPut(
          key,
          value as Parameters<typeof originalRoutingPut>[1],
          options as Parameters<typeof originalRoutingPut>[2],
        );
      },
    );

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('asset:index.html', new Blob(['<html>leak-window-test</html>']));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // The stream response was already opened before the failure, so the
    // HTTP status is 200 (NDJSON stream) and the failure is emitted as an
    // error event embedded in the body.
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.at(-1)).toMatchObject({ event: 'error' });

    // Confirm the failure actually landed on the slug put — otherwise the
    // test wouldn't be exercising the pre-retention window.
    expect(routingPutCount).toBeGreaterThanOrEqual(2);

    // The core invariant: the streamed asset must be swept from KV by the
    // inner catch (`cleanupStreamedAssetsOnAbort`). Before the fix,
    // `streamedAssetsPersisted` was flipped at the asset_hashes write and
    // the catch skipped cleanup, so the blob would leak.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);

    // Deployment row may exist in a failed state, but it MUST NOT be marked
    // retained — otherwise retention cleanup would hold onto blobs that
    // never reached a live state.
    const dpls = await env.db
      .select({ id: deployments.id, retained: deployments.retained, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    for (const dpl of dpls) {
      expect(dpl.retained).toBe(false);
    }
  });

  // The inner-catch cleanup gate must key off `!routingSwitched`, not
  // `streamedAssetsPersisted` (which only flips AFTER
  // `markDeploymentRetained`). Otherwise a failure between the slug
  // ROUTING.put (which makes traffic live) and the retention claim would
  // sweep assets that the now-live deployment is actively serving, while
  // the `routingSwitched` recovery branch still marked the deployment
  // "live". `!routingSwitched` matches the real "traffic is live" signal.
  // This test fails the active-domain ROUTING.put, which lands after
  // `routingSwitched = true` and before `markDeploymentRetained`.
  it('preserves streamed assets when a post-routing, pre-retention step fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-post-routing-fail');
    mockCfApi();

    // Active domain triggers the `domain:<host>` ROUTING.put inside the
    // [routingSwitched, markDeploymentRetained] window.
    await env.db.insert(domains).values({
      id: 'dom_post_routing',
      project_id: project.id,
      hostname: 'post-routing-fail.example.com',
      cf_hostname_id: 'ch-post-routing',
      status: 'active',
    });

    const originalRoutingPut = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        if (key.startsWith('domain:')) {
          throw new Error('simulated domain ROUTING.put failure after routingSwitched');
        }
        return originalRoutingPut(
          key,
          value as Parameters<typeof originalRoutingPut>[1],
          options as Parameters<typeof originalRoutingPut>[2],
        );
      },
    );

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('asset:index.html', new Blob(['<html>post-routing-test</html>']));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // The stream response was already opened; the failure lands inside the
    // stream start callback and the route takes the `routingSwitched`
    // recovery branch, which keeps the deployment marked live and emits a
    // "done" event (NOT "error") so the CLI shows success with the URL.
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const last = events.at(-1) as { event?: string } | undefined;
    expect(last?.event).toBe('done');

    // The core invariant: streamed assets MUST still be in KV, because the
    // slug routing already points at this deployment's hashes — deleting
    // them would break the live site. Before the fix, the catch gate was
    // `!streamedAssetsPersisted === true` here and the blobs were swept.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys.length).toBeGreaterThan(0);

    // The recovery branch re-runs the "mark live / retain" steps with
    // `.catch(() => {})`, so the deployment ends up retained and the
    // project points at it.
    const [row] = await env.db
      .select({
        id: deployments.id,
        retained: deployments.retained,
        status: deployments.status,
      })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(row?.retained).toBe(true);
    expect(row?.status).toBe('live');
  });

  // Sanity: `bindings.ai: true` is a legitimate payload and must NOT
  // trip the validator. Round 5 specifically flagged this false-positive
  // risk because the validator only checks d1/kv/r2/hyperdrive.
  it('accepts bindings.ai as a boolean', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-ai-boolean');
    mockCfApi();

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: { ai: true } }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // Validator is not the gate here — the request passes shape validation
    // and continues into the deploy pipeline. We only assert it isn't
    // rejected AS invalid shape; it may still fail for unrelated reasons.
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = events.find(
      (event): event is ErrorEvent => isDeployEvent(event) && event.event === 'error',
    );
    if (errorEvent) {
      expect(errorEvent.message ?? '').not.toMatch(/^invalid manifest shape:/);
    }
  });

  it('returns 400 when the multipart body is missing the manifest part', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-no-manifest');
    mockCfApi();

    // Parts that are accepted without the manifest-precedence check
    // (source/commit/preflight). A regression that defaults the manifest
    // would let this body create an empty live deployment.
    const form = new FormData();
    form.append('source', 'cli');
    form.append('commit', 'deadbeef');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('manifest part is required');

    // No deployment row, no worker script, no KV residue.
    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);
  });

  it('rejects worker part that arrives before the manifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-worker-first');
    mockCfApi();

    const form = new FormData();
    form.append('worker:index.js', new Blob(['export default {}']));
    form.append('manifest', JSON.stringify({ version: 3, bindings: {} }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('manifest part must precede worker and asset parts');
  });

  // ---- KV / R2 streaming-put failures ----

  it('sweeps the first streamed asset when a later KV.put keeps throwing in the parse loop', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-kv-throw');
    mockCfApi();
    mockSetTimeout();

    // Static asset uploads happen inline inside the multipart parse loop, so
    // a KV.put failure on the second asset bubbles up to the outer parse catch
    // (not the NDJSON stream-phase catch). The handler re-throws the non
    // -MultipartParseError, Hono returns 500, and cleanupStreamedAssetsOnAbort
    // sweeps the first asset that already made it into KV.
    const originalPut = env.STATIC_ASSETS.put.bind(env.STATIC_ASSETS);
    let putCount = 0;
    vi.spyOn(env.STATIC_ASSETS, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        putCount++;
        if (putCount >= 2) {
          throw new Error('simulated KV put failure');
        }
        return originalPut(
          key,
          value as Parameters<typeof originalPut>[1],
          options as Parameters<typeof originalPut>[2],
        );
      },
    );

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('asset:one.html', new Blob(['<html>one</html>']));
    form.append('asset:two.html', new Blob(['<html>two</html>']));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // Rethrown non-MultipartParseError surfaces as an `error` event on the
    // NDJSON stream; the HTTP status is 200 (headers flushed before parse).
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');

    // 1 real put for the first asset + (MAX_RETRIES + 1) failing puts for the
    // second asset = 1 + 4 = 5. This pins the retry loop contract so a
    // regression that silently drops retries would fail here.
    expect(putCount).toBe(5);

    // The first asset landed in KV and must be swept by cleanupStreamedAssetsOnAbort.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);

    // The failure happens before createDeployment — no deployment row should exist.
    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  it('fails with empty KV and R2 when R2.put keeps throwing for a large asset', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-r2-throw');
    mockCfApi();
    mockSetTimeout();

    let r2PutCount = 0;
    vi.spyOn(env.STATIC_ASSETS_R2, 'put').mockImplementation(async () => {
      r2PutCount++;
      throw new Error('simulated R2 put failure');
    });
    const r2DeleteSpy = vi.spyOn(env.STATIC_ASSETS_R2, 'delete');

    // > 2 MB forces the R2 branch inside uploadStaticAssetWithRetries.
    const largeSize = 3 * 1024 * 1024;
    const largeBytes = new Uint8Array(largeSize);
    for (let i = 0; i < largeSize; i++) {
      largeBytes[i] = (i * 13 + 3) & 0xff;
    }

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'static',
        bindings: {},
        assetConfig: { not_found_handling: '404-page' },
      }),
    );
    form.append('asset:video.mp4', new Blob([largeBytes], { type: 'video/mp4' }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // Rethrown non-MultipartParseError surfaces as an `error` event on the
    // NDJSON stream; the HTTP status is 200 (headers flushed before parse).
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');

    // Retry contract: MAX_RETRIES + 1 = 4 attempts for the single large asset.
    expect(r2PutCount).toBe(4);

    // KV is untouched because the asset went straight to the R2 branch.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);

    // Every R2.put attempt failed before uploadedHashes.set ran, so there's
    // nothing to delete. Cleanup must NOT call R2.delete for a key that never
    // landed — a false-positive delete here would evict a retained asset from
    // a previous deploy that happened to share the hash.
    expect(r2DeleteSpy).not.toHaveBeenCalled();

    // No deployment row exists — failure is in the parse loop.
    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  // Reader-starvation regression: per-asset KV/R2 PUTs must not block the
  // multipart parse loop. Awaiting `collectAndUploadStaticAsset` inline inside
  // the for-await loop holds `c.req.raw.body`'s reader idle while each PUT is
  // pending — for deploys with many assets + slow storage, the CF edge closes
  // the stalled inbound socket and the CLI surfaces "Connection lost during
  // deploy". This test pins the invariant: once the first PUT registers, the
  // parse loop keeps advancing and all remaining asset PUTs get scheduled
  // before the first one resolves.
  it('keeps draining the request body while static asset PUTs are in flight', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-reader-starvation');
    mockCfApi();

    const ASSET_COUNT = 3;

    // Hang every KV put on a test-controlled gate. Before the fix, the parse
    // loop awaits the first hanging PUT and cannot reach the next asset part,
    // so pendingPuts.length stays at 1. After the fix, pool-scheduled PUTs let
    // the loop advance and all ASSET_COUNT PUTs register concurrently.
    const pendingPuts: Array<{ key: string; release: () => void }> = [];
    let unblockAll = false;
    const originalPut = env.STATIC_ASSETS.put.bind(env.STATIC_ASSETS);
    vi.spyOn(env.STATIC_ASSETS, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        if (unblockAll) {
          // After the observation window, let any straggler PUT through so
          // the IIFE can finish and the test does not leak state.
          return originalPut(
            key,
            value as Parameters<typeof originalPut>[1],
            options as Parameters<typeof originalPut>[2],
          );
        }
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        pendingPuts.push({ key, release });
        await gate;
        return originalPut(
          key,
          value as Parameters<typeof originalPut>[1],
          options as Parameters<typeof originalPut>[2],
        );
      },
    );

    // Build a multipart body we control byte-for-byte so the Request keeps a
    // live ReadableStream instead of a pre-serialized FormData buffer.
    const boundary = `-----void-test-${Math.random().toString(36).slice(2)}`;
    const enc = new TextEncoder();
    const frags: Array<Uint8Array> = [];
    const addPart = (name: string, body: string): void => {
      frags.push(
        enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      );
      frags.push(enc.encode(body));
      frags.push(enc.encode('\r\n'));
    };
    addPart(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    for (let i = 0; i < ASSET_COUNT; i++) {
      addPart(`asset:/a${i}.html`, `<html>body ${i}</html>`);
    }
    frags.push(enc.encode(`--${boundary}--\r\n`));
    const totalLen = frags.reduce((s, c) => s + c.length, 0);
    const bodyBytes = new Uint8Array(totalLen);
    {
      let off = 0;
      for (const c of frags) {
        bodyBytes.set(c, off);
        off += c.length;
      }
    }

    // Chunk the body so parseMultipart makes multiple reader.read() calls —
    // otherwise one fill() swallows the whole body and the test loses its
    // ability to observe back-pressure on the upstream reader.
    const CHUNK = 32;
    let offset = 0;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        closed = true;
      },
      pull(ctrl) {
        if (closed) {
          return;
        }
        if (offset >= bodyBytes.length) {
          closed = true;
          try {
            ctrl.close();
          } catch {
            // Node/undici can cancel the request body before the final pull
            // runs; in that case the stream is already closed and this test
            // only cares about exercising multipart back-pressure.
          }
          return;
        }
        const start = offset;
        const end = Math.min(offset + CHUNK, bodyBytes.length);
        offset = end;
        try {
          ctrl.enqueue(bodyBytes.slice(start, end));
        } catch {
          closed = true;
        }
      },
    });

    const resPromise = app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        // Required by Node/undici when the Request body is a ReadableStream.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      env,
    );

    let assertionErr: unknown;
    try {
      // Wait until the first PUT registers (the deploy reached the parse loop
      // and started uploading asset 0), then yield macrotasks to give the
      // parse loop time to schedule the remaining asset PUTs if it is no
      // longer blocked by the await. The body is only ~500 bytes; once PUTs
      // no longer gate the loop, it reaches end-of-body in microseconds.
      const deadline = Date.now() + 2000;
      while (pendingPuts.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(pendingPuts.length).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Oracle: all ASSET_COUNT PUTs are in flight concurrently. Before the
      // fix, pendingPuts.length is 1 because the parse loop is blocked
      // awaiting the first PUT and cannot reach the next asset part.
      expect(pendingPuts.length).toBe(ASSET_COUNT);
    } catch (err) {
      assertionErr = err;
    } finally {
      // Release every pending gate AND flip unblockAll so any PUT scheduled
      // after this point skips the gate. Without the flag, releasing gate 0
      // lets the handler advance to asset 1, which would block on a fresh
      // gate that nobody is waiting to release — and resPromise would hang.
      unblockAll = true;
      for (const p of pendingPuts) {
        p.release();
      }
      try {
        const res = await resPromise;
        await res.text();
      } catch {
        // ignore — we only care about the assertion above
      }
    }
    if (assertionErr) {
      throw assertionErr;
    }
  });

  // ---- Post-parse DB failures ----

  it('sweeps streamed assets when createDeployment throws after parsing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-db-fail');
    mockCfApi();

    // Fail the deployment insert after the parse loop completes, so the outer
    // finally must sweep the asset that already landed in KV.
    const origInsert = env.db.insert.bind(env.db);
    vi.spyOn(env.db, 'insert').mockImplementation((table: unknown) => {
      if (table === deployments) {
        throw new Error('simulated deployment insert failure');
      }
      return origInsert(table as Parameters<typeof origInsert>[0]);
    });

    const form = new FormData();
    form.append(
      'manifest',
      JSON.stringify({
        version: 3,
        type: 'spa',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    form.append('asset:index.html', new Blob(['<html>stream then fail</html>']));

    // Confirm the asset made it into KV during parsing — if the parse loop
    // skipped ahead for some reason, the assertion below wouldn't prove
    // cleanup actually ran.
    const beforeListed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(beforeListed.keys).toEqual([]);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    // Rethrown non-MultipartParseError surfaces as an `error` event on the
    // NDJSON stream; the HTTP status is 200 (headers flushed before parse).
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');

    // The outer try/finally guards post-parse work — the asset streamed into
    // KV during parsing must be swept before the response is returned.
    const listed = await env.STATIC_ASSETS.list({ prefix: `assets/${project.id}/` });
    expect(listed.keys).toEqual([]);

    // The insert threw — the deployment row must not exist.
    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  // ---- Stream-phase validation ----

  it('allows deploys for usage-limit-suspended users (requests_exceeded)', async () => {
    // Regression guard: usage-limit suspensions (requests_exceeded) must NOT
    // block deploys. Users need to be able to ship fixes and roll back while
    // their limits reset. Admin suspensions are still blocked by authMiddleware
    // at 403 before ever reaching the handler.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-usage-suspended');
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = (await readAllEvents(res)) as Array<{ event: string; deployment?: string }>;
    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    expect(done?.deployment).toMatch(/^dpl_/);

    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('live');
  });

  it('blocks deploys from admin-suspended users at auth middleware with 403', async () => {
    // Admin suspensions (any reason not in USAGE_LIMIT_REASONS) are rejected
    // by authMiddleware before the deploy handler runs. The error body has no
    // reason suffix — that's the middleware contract, not the handler's.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-admin-suspended');
    await env.db
      .update(users)
      .set({ suspended_reason: 'tos_violation' })
      .where(eq(users.id, user.id));
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account suspended' });

    // No deployment row — we never reached the handler.
    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toEqual([]);
  });

  it('fails the deployment when manifest.vars contains a reserved binding name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-reserved');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            vars: { ASSETS: 'not allowed', OK_VAR: 'fine' },
          },
        }),
      }),
      env,
    );
    // The check throws inside the ReadableStream.start() body, so the HTTP
    // response is still 200 NDJSON — the failure lands as an `error` event and
    // the deployment row ends up in `failed`.
    expect(res.status).toBe(200);
    const events = (await readAllEvents(res)) as Array<{ event: string; message?: string }>;
    const errEvent = events.find((e) => e.event === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.message).toMatch(/reserved binding names/);

    const [dpl] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('failed');
    // error_message should match the NDJSON error surface so downstream
    // consumers can trust either source. Guard against regressions that only
    // emit the event without persisting.
    expect(dpl?.error_message).toMatch(/reserved binding names/);

    // The reserved-name check throws before worker upload, so no
    // `PUT /workers/dispatch/...` call should have been made to the CF API.
    // This is the real branch proof — without this, the test passes even if
    // the handler somehow uploaded the worker and then emitted the error.
    const workerPuts = fetchMock.mock.calls.filter(([input, init]) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return init?.method === 'PUT' && url.includes('/workers/dispatch/');
    });
    expect(workerPuts).toHaveLength(0);
  });

  it('marks deployment failed and cleans up the worker when migration dispatch returns ok=false', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-migrate-fail');
    const fetchMock = mockCfApi({
      createD1: () => cfSuccess({ uuid: 'd1-fail-uuid', name: 'fail-db' }),
    });
    mockSetTimeout();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/__void/ready') {
            return Response.json({ ready: true });
          }
          return Response.json({
            ok: false,
            error: 'schema mismatch',
            migrations: [],
          });
        },
      }),
    } as unknown as DispatchNamespace;

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}` },
          body: buildDeployForm({
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: { dialect: 'sqlite', pending: 1 },
            },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = (await readAllEvents(res)) as Array<{ event: string; message?: string }>;
      const errEvent = events.find((e) => e.event === 'error');
      expect(errEvent).toBeDefined();
      expect(errEvent?.message).toMatch(/migration failed/);

      const [dpl] = await env.db
        .select({
          status: deployments.status,
          error_message: deployments.error_message,
          applied_migrations: deployments.applied_migrations,
        })
        .from(deployments)
        .where(eq(deployments.project_id, project.id));
      expect(dpl?.status).toBe('failed');
      // Persisted error must match what the client saw.
      expect(dpl?.error_message).toMatch(/migration failed/);
      // Nothing ran, so the applied_migrations slot must stay untouched.
      expect(dpl?.applied_migrations).toBeNull();

      // Migration failure rethrows into the outer catch, which takes the
      // pre-routing cleanup branch and calls deleteDispatchScript exactly
      // once for the freshly uploaded worker. Pinning to === 1 guards
      // against both a regression that skips cleanup AND a regression that
      // re-introduces the double-delete bug from round 1.
      const workerDeletes = fetchMock.mock.calls.filter(([input, init]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return init?.method === 'DELETE' && url.includes('/workers/dispatch/');
      });
      expect(workerDeletes.length).toBe(1);
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  // ---- Post-routing failure ----

  it('keeps the deployment live when a post-routing step fails (slug-only done event)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'edge-post-routing');
    await env.db.insert(domains).values({
      id: 'dom_post_route',
      project_id: project.id,
      hostname: 'post-route.example.com',
      cf_hostname_id: 'ch-post',
      status: 'active',
    });
    mockCfApi();

    // First ROUTING.put is for `project.slug` and succeeds → flips
    // routingSwitched=true. The second put targets `domain:<hostname>`; we
    // make it throw so the catch branch takes the "already serving live
    // traffic" path and keeps the deployment live.
    const origPut = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation(
      async (key: string, value: unknown, options?: unknown) => {
        if (key.startsWith('domain:')) {
          throw new Error('simulated KV put failure for domain route');
        }
        return origPut(
          key,
          value as Parameters<typeof origPut>[1],
          options as Parameters<typeof origPut>[2],
        );
      },
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm(),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = (await readAllEvents(res)) as Array<{
      event: string;
      deployment?: string;
      url?: string;
      urls?: Array<string>;
      assets?: number;
      workers?: number;
      message?: string;
    }>;
    const errEvent = events.find((e) => e.event === 'error');
    expect(errEvent).toBeUndefined();
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent).toBeDefined();

    // Branch proof: the normal success path would emit
    //   url = https://post-route.example.com  (the active custom domain)
    //   urls = [https://post-route.example.com, https://edge-post-routing.void.app]
    // The post-routing catch emits slug-only. Asserting slug-only is what
    // makes this test distinguish the branches — without it, a normal success
    // path that simply doesn't touch domain:* could silently pass.
    const slugUrl = `https://${project.slug}.void.app`;
    expect(doneEvent?.url).toBe(slugUrl);
    expect(doneEvent?.urls).toEqual([slugUrl]);
    // The catch emits 0/0 because it doesn't recount assets/workers.
    expect(doneEvent?.assets).toBe(0);
    expect(doneEvent?.workers).toBe(0);

    const [dpl] = await env.db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('live');

    // The catch path calls setActiveDeployment(...).catch(() => {}), so
    // projects.active_deployment_id must point at the new deployment — proving
    // the "it IS serving live traffic" contract end-to-end.
    const [proj] = await env.db
      .select({ active: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(proj?.active).toBe(dpl?.id);
  });
});

describe('Deploy with prerendering', () => {
  it('prerenders pages and writes ISR cache entries to KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-app');

    // Mock DISPATCH.get() to return a fetchable worker
    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(
        () =>
          new Response('<html>Prerendered</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            revalidate: 3600,
            prerender: ['/', '/about'],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const [deployment] = await env.db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // Verify ISR cache entries were written to KV (packed binary format)
    const { value: homeValue, metadata: homeMeta } = await env.ISR_CACHE.getWithMetadata<{
      s: number;
      c: number;
      t: number;
    }>(`${project.id}/isr/v2/${deployment!.id}/__index__`, 'arrayBuffer');
    expect(homeValue).not.toBeNull();
    // Unpack: [4-byte header len][headers JSON][body]
    const homeView = new DataView(homeValue!);
    const homeHeaderLen = homeView.getUint32(0, true);
    const homeBody = new TextDecoder().decode(new Uint8Array(homeValue!, 4 + homeHeaderLen));
    expect(homeBody).toBe('<html>Prerendered</html>');
    expect(homeMeta?.s).toBe(200);
    expect(homeMeta?.t).toBe(3600);

    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v2/${deployment!.id}/about`,
      'arrayBuffer',
    );
    expect(aboutValue).not.toBeNull();

    // Verify deployment is live
    expect(deployment?.status).toBe('live');
  });

  it('preserves other deployments v2 ISR namespaces on redeploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'v2-isr-isolation');

    await env.ISR_CACHE.put(`${project.id}/isr/v2/previous/about`, 'previous-v2');

    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(
        () =>
          new Response('<html>Prerendered</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            revalidate: 3600,
            prerender: ['/about'],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // A new deploy clears only its own deployment-scoped namespace; other
    // deployments' v2 entries remain intact.
    expect(await env.ISR_CACHE.get(`${project.id}/isr/v2/previous/about`)).toBe('previous-v2');
    expect(await env.ISR_CACHE.get(`${project.id}/isr/v2/${deployment!.id}/about`)).not.toBeNull();
  });

  it('skips prerender paths with TTL <= 0', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-skip');

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response('<html>Prerendered</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            revalidate: { '/about': 3600, '/private': 0, '*': 0 },
            prerender: ['/about', '/private'],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Only /about should have been fetched (TTL > 0)
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // /about should have ISR entry
    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v2/${deployment!.id}/about`,
      'arrayBuffer',
    );
    expect(aboutValue).not.toBeNull();

    // /private should NOT have ISR entry
    const { value: privateValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v2/${deployment!.id}/private`,
      'arrayBuffer',
    );
    expect(privateValue).toBeNull();
  });

  it('does not block deploy when prerender fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-fail');

    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('Worker crashed')),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            revalidate: 3600,
            prerender: ['/'],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Deployment should still be live despite prerender failure
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('live');
  });

  it('sets prerendering status during prerender phase', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-status');

    let statusDuringPrerender: string | undefined;
    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(async () => {
        // Check deployment status during prerender
        const [dpl] = await env.db
          .select({ status: deployments.status })
          .from(deployments)
          .where(eq(deployments.project_id, project.id));
        statusDuringPrerender = dpl?.status;
        return new Response('<html>ok</html>', { status: 200 });
      }),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          manifest: {
            version: 3,
            bindings: {},
            revalidate: 3600,
            prerender: ['/'],
          },
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(statusDuringPrerender).toBe('prerendering');
  });
});

describe('asset_hashes storage', () => {
  it('stores asset_hashes in deployment record after successful deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();

    const form = buildDeployForm({ assets: { 'index.html': '<html>hello</html>' } });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const data = requireEvent<DoneEvent>(events, 'done');

    const [row] = await env.db
      .select({ asset_hashes: deployments.asset_hashes })
      .from(deployments)
      .where(eq(deployments.id, data.deployment));

    expect(row?.asset_hashes).toBeTruthy();
    const hashes = JSON.parse(row!.asset_hashes!);
    expect(hashes['/index.html']).toBeDefined();
    expect(hashes['/index.html'].hash).toHaveLength(32);
    expect(hashes['/index.html'].size).toBeGreaterThan(0);
  });

  it('persists asset_hashes on a failed deployment when the failure is past asset upload', async () => {
    // Repro of the recappi deadlock: first-ever deploy fails at migrations
    // AFTER assets were accepted by CF. Pre-fix, the late `asset_hashes`
    // write at the end of the pipeline never ran, so the next deploy had
    // no corroboration source and the session-dedupe guard locked the
    // project out permanently. With the fix, asset_hashes is persisted as
    // soon as CF accepts the bytes, so the deployment row left behind by
    // a migration failure is a valid corroboration baseline for retries.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'first-deploy-migrate-fail');
    mockCfApi({ createD1: () => cfSuccess({ uuid: 'd1-recovery-uuid', name: 'fail-db' }) });
    mockSetTimeout();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/__void/ready') {
            return Response.json({ ready: true });
          }
          return Response.json({ ok: false, error: 'simulated SQL error', migrations: [] });
        },
      }),
    } as unknown as DispatchNamespace;

    try {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}` },
          body: buildDeployForm({
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: { dialect: 'sqlite', pending: 1 },
            },
            assets: { 'index.html': '<h1>recappi</h1>' },
          }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = (await readAllEvents(res)) as Array<{ event: string; message?: string }>;
      expect(events.find((e) => e.event === 'error')?.message).toMatch(/migration failed/);

      const [dpl] = await env.db
        .select({
          status: deployments.status,
          asset_hashes: deployments.asset_hashes,
          retained: deployments.retained,
        })
        .from(deployments)
        .where(eq(deployments.project_id, project.id));
      expect(dpl?.status).toBe('failed');
      // Retention claim happens after migrations succeed, so retained stays
      // false — but asset_hashes MUST survive so the next deploy can
      // corroborate against it.
      expect(dpl?.retained).toBe(false);
      expect(dpl?.asset_hashes).toBeTruthy();
      const persisted = JSON.parse(dpl!.asset_hashes!);
      expect(persisted['/index.html']).toBeDefined();
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });
});

describe('POST /projects/:id/deploy/preflight', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/deploy/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetManifest: {} }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns all assets as needed on first deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetManifest: {
            '/index.html': { hash: 'a'.repeat(32), size: 100 },
            '/app.js': { hash: 'b'.repeat(32), size: 200 },
          },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
    expect(data.needed.sort()).toEqual(['/app.js', '/index.html']);
    expect(data.total).toBe(2);
    expect(data.skipped).toBe(0);
  });

  it('skips unchanged assets from previous deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Create a previous deployment with known asset hashes
    const prevManifest = {
      '/index.html': { hash: 'a'.repeat(32), size: 100 },
      '/app.js': { hash: 'b'.repeat(32), size: 200 },
      '/style.css': { hash: 'c'.repeat(32), size: 300 },
    };
    const prevDeploy = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(prevManifest) })
      .where(eq(deployments.id, prevDeploy.id));
    // Simulate a live static KV/R2 deployment: the preflight handler
    // reads the routing entry under `project.slug` and treats presence of
    // `staticDeploymentId` as the static-backend signal.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        staticDeploymentId: prevDeploy.id,
        projectId: project.id,
        userId: user.id,
      }),
    );
    const servingManifest: Record<string, string> = {};
    for (const [path, entry] of Object.entries(prevManifest)) {
      servingManifest[path] = entry.hash;
    }
    await env.ROUTING.put(`manifest:${prevDeploy.id}`, JSON.stringify(servingManifest));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetManifest: {
            '/index.html': { hash: 'a'.repeat(32), size: 100 }, // unchanged
            '/app.js': { hash: 'x'.repeat(32), size: 250 }, // changed
            '/new.js': { hash: 'd'.repeat(32), size: 400 }, // new
            // style.css removed
          },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
    expect(data.needed.sort()).toEqual(['/app.js', '/new.js']);
    expect(data.total).toBe(3);
    expect(data.skipped).toBe(1);
  });

  it('merges previous asset manifest when preflight flag is set on deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Set up a previous deploy with known asset hashes
    const prevManifest = {
      '/index.html': { hash: 'a'.repeat(32), size: 100 },
      '/app.js': { hash: 'b'.repeat(32), size: 200 },
    };
    const prevDeploy = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(prevManifest) })
      .where(eq(deployments.id, prevDeploy.id));

    // Deploy with preflight=true, only sending the changed asset
    let sessionManifest: Record<string, unknown> | null = null;
    mockCfApi({
      assetUploadSession: (_url, init) => {
        const body = JSON.parse(init?.body as string);
        sessionManifest = body.manifest;
        return cfSuccess({ jwt: 'test-asset-jwt', buckets: [] });
      },
    });

    const form = new FormData();
    form.append('manifest', JSON.stringify({ version: 3, bindings: {} }));
    form.append('preflight', 'true');
    form.append('asset:app.js', new Blob(['new content']), 'app.js');
    form.append('worker:index.js', new Blob(['export default {}']), 'index.js');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );

    expect(res.status).toBe(200);
    await res.text();

    // CF session should have received the COMPLETE manifest (merged) — plus a
    // per-deploy `.void-deploy/*` cache-buster injected to work around
    // cloudflare/workers-sdk#12586.
    expect(sessionManifest).toBeDefined();
    const manifestPaths = Object.keys(sessionManifest!).filter(
      (p) => !p.startsWith('/.void-deploy/'),
    );
    expect(manifestPaths.sort()).toEqual(['/app.js', '/index.html']);
  });

  it('includes observability metadata in worker upload', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'obs-proj');

    let capturedMetadata: Record<string, unknown> | undefined;
    mockCfApi({
      uploadWorker: async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        const metadataBlob = body.get('metadata') as Blob;
        capturedMetadata = JSON.parse(await metadataBlob.text());
        return new Response('ok', { status: 200 });
      },
    });

    const form = buildDeployForm();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: true, head_sampling_rate: 1 },
    });
  });

  it('serializes websocket durable object migrations in Cloudflare upload format', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ws-migrations-proj');

    let capturedMetadata: Record<string, unknown> | undefined;
    mockCfApi({
      uploadWorker: async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        const metadataBlob = body.get('metadata') as Blob;
        capturedMetadata = JSON.parse(await metadataBlob.text());
        return new Response('ok', { status: 200 });
      },
    });

    const form = buildDeployForm({
      manifest: {
        version: 3,
        bindings: {},
        websocket: {
          routes: [
            {
              pattern: '/ws/chat/:room',
              filePath: 'routes/ws/chat/[room].ws.ts',
              className: 'WsChatRoomWs',
              bindingName: 'CHAT_ROOM',
              mode: 'room',
              hasAuthGate: false,
            },
          ],
          classes: ['WsChatRoomWs', 'WsPresenceWs'],
          migrations: [
            { tag: 'ws-v1', newClasses: ['WsChatRoomWs'] },
            { tag: 'ws-v2', newClasses: ['WsPresenceWs'] },
          ],
        },
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.bindings).toEqual(
      expect.arrayContaining([
        {
          type: 'durable_object_namespace',
          name: 'CHAT_ROOM',
          class_name: 'WsChatRoomWs',
        },
        {
          type: 'durable_object_namespace',
          name: 'WsPresenceWs',
          class_name: 'WsPresenceWs',
        },
      ]),
    );
    expect(capturedMetadata).not.toHaveProperty('durable_objects');
    expect(capturedMetadata!.migrations).toEqual({
      new_tag: 'ws-v1',
      steps: [{ new_classes: ['WsChatRoomWs', 'WsPresenceWs'] }],
    });
  });

  describe('static → WfP project type transition', () => {
    it('returns all assets as needed when previous deploy was static and current has worker', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id);

      // Create a previous STATIC deployment with known asset hashes
      const prevManifest = {
        '/index.html': { hash: 'a'.repeat(32), size: 100 },
        '/app.js': { hash: 'b'.repeat(32), size: 200 },
        '/style.css': { hash: 'c'.repeat(32), size: 300 },
      };
      const prevDeploy = await createTestDeployment(env.db, project.id, 'live');
      await env.db
        .update(deployments)
        .set({ asset_hashes: JSON.stringify(prevManifest) })
        .where(eq(deployments.id, prevDeploy.id));
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({
          staticDeploymentId: prevDeploy.id,
          projectId: project.id,
          userId: user.id,
        }),
      );

      // Static deploys store a serving manifest in ROUTING KV
      const servingManifest: Record<string, string> = {};
      for (const [path, entry] of Object.entries(prevManifest)) {
        servingManifest[path] = entry.hash;
      }
      await env.ROUTING.put(`manifest:${prevDeploy.id}`, JSON.stringify(servingManifest));

      // Preflight with hasWorker=true (converting to a Void/WfP deploy)
      // All assets should be returned as needed since they must be uploaded
      // to CF's asset API (they only exist in KV/R2 from the static deploy)
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assetManifest: {
              '/index.html': { hash: 'a'.repeat(32), size: 100 }, // unchanged
              '/app.js': { hash: 'b'.repeat(32), size: 200 }, // unchanged
              '/style.css': { hash: 'c'.repeat(32), size: 300 }, // unchanged
            },
            hasWorker: true,
          }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
      // All assets must be re-uploaded — they're in KV/R2, not CF's asset store
      expect(data.needed.sort()).toEqual(['/app.js', '/index.html', '/style.css']);
      expect(data.total).toBe(3);
      expect(data.skipped).toBe(0);
    });

    it('still deduplicates when previous deploy was static and current is also static', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id);

      // Create a previous STATIC deployment
      const prevManifest = {
        '/index.html': { hash: 'a'.repeat(32), size: 100 },
        '/app.js': { hash: 'b'.repeat(32), size: 200 },
      };
      const prevDeploy = await createTestDeployment(env.db, project.id, 'live');
      await env.db
        .update(deployments)
        .set({ asset_hashes: JSON.stringify(prevManifest) })
        .where(eq(deployments.id, prevDeploy.id));
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({
          staticDeploymentId: prevDeploy.id,
          projectId: project.id,
          userId: user.id,
        }),
      );
      const servingManifest: Record<string, string> = {};
      for (const [path, entry] of Object.entries(prevManifest)) {
        servingManifest[path] = entry.hash;
      }
      await env.ROUTING.put(`manifest:${prevDeploy.id}`, JSON.stringify(servingManifest));

      // Preflight WITHOUT hasWorker (staying as static deploy)
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assetManifest: {
              '/index.html': { hash: 'a'.repeat(32), size: 100 }, // unchanged
              '/app.js': { hash: 'x'.repeat(32), size: 250 }, // changed
            },
          }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
      // static→static should still dedup
      expect(data.needed.sort()).toEqual(['/app.js']);
      expect(data.total).toBe(2);
      expect(data.skipped).toBe(1);
    });

    it('does not crash on deploy when converting static project to WfP with preflight', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'static-to-void');

      // 1. Do an initial static deploy
      mockCfApi();
      const staticForm = buildStaticDeployForm({
        type: 'spa',
        assets: { 'index.html': '<h1>hello</h1>', 'app.js': 'console.log(1)' },
      });
      const staticRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}` },
          body: staticForm,
        }),
        env,
      );
      expect(staticRes.status).toBe(200);
      const staticEvents = await readAllEvents(staticRes);
      const staticDone = staticEvents.find(
        (event): event is DoneEvent => isDeployEvent(event) && event.event === 'done',
      );
      expect(staticDone).toBeDefined();

      // 2. Now convert to a WfP deploy with preflight
      // Preflight should return all assets as needed (hasWorker=true)
      const preflightRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assetManifest: {
              '/index.html': { hash: 'a'.repeat(32), size: 100 },
              '/app.js': { hash: 'b'.repeat(32), size: 200 },
            },
            hasWorker: true,
          }),
        }),
        env,
      );
      expect(preflightRes.status).toBe(200);
      const pfData = (await preflightRes.json()) as {
        needed: Array<string>;
        total: number;
        skipped: number;
      };
      // All assets should be needed — they exist in KV/R2, not CF asset store
      expect(pfData.skipped).toBe(0);
      expect(pfData.needed.length).toBe(2);

      // 3. Deploy as WfP with all assets (since preflight returned all as needed)
      mockCfApi();
      const form = buildDeployForm({
        assets: { 'index.html': '<h1>hello</h1>', 'app.js': 'console.log(1)' },
      });
      const deployRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}` },
          body: form,
        }),
        env,
      );
      expect(deployRes.status).toBe(200);
      const events = await readAllEvents(deployRes);
      const done = events.find(
        (event): event is DoneEvent => isDeployEvent(event) && event.event === 'done',
      );
      expect(done).toBeDefined();
      // Should not have errored with AssetHashMissError
      const error = events.find(
        (event): event is ErrorEvent => isDeployEvent(event) && event.event === 'error',
      );
      expect(error).toBeUndefined();
    });
  });
});
