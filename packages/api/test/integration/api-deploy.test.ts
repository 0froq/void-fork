import { eq, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { computeAssetHash } from '../../src/assets';
import { updateDeploymentStatus } from '../../src/db';
import app from '../../src/index';
import { deployments, resources, domains, projects, projectSecrets } from '../../src/schema';
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

function parseDeployStream(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function mockSetTimeout() {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler, ...args: unknown[]) =>
    nativeSetTimeout(fn, 0, ...args)) as typeof setTimeout);
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
    const done = events.find((e: any) => e.event === 'done') as any;
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
    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
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
    const cronDoFetches: { url: string; body: string }[] = [];
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

    const cronDoFetches: { url: string }[] = [];
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
    const createD1Call = fetchMock.mock.calls.find((call: unknown[]) => {
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

      const migrationStart = events.find((e: any) => e.event === 'migration_start') as any;
      expect(migrationStart.pending).toBe(1);

      const migration = events.find((e: any) => e.event === 'migration') as any;
      expect(migration.name).toBe('001_create_table.sql');

      const done = events.find((e: any) => e.event === 'done') as any;
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
    const done = events.find((e: any) => e.event === 'done') as any;
    expect(done.url).toBe('https://deploy.example.com');
    expect(done.urls).toContain('https://deploy.example.com');
    expect(done.urls).toContain('https://domain-deploy.void.app');

    // Verify domain KV routing was written
    const domainRouting = await env.ROUTING.get('domain:deploy.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: expect.stringMatching(/^user-domain-deploy-dpl_/),
      projectId: project.id,
      userId: user.id,
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
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe('deploy limit exceeded');
    expect(body.limit).toBe(100);
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

    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: { type: string; name: string; text?: string }[];
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

    const setSecretCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && url.includes('/secrets');
    });
    expect(setSecretCall).toBeUndefined();

    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
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
      bindings?: { type: string; name: string; text?: string }[];
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
    const error = events.find((event: any) => event.event === 'error') as any;
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
    const error = events.find((e: any) => e.event === 'error') as any;
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
    const consumerCall = fetchMock.mock.calls.find((call: unknown[]) => {
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

    const uploadCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: { type: string; name: string; queue_name?: string; queue_id?: string }[];
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

    // Verify queue routing KV entry (key uses deterministic queue name)
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const queueRouting = await env.ROUTING.get(`queue:${expectedQueueName}`, 'json');
    expect(queueRouting).toEqual({
      workerName: expect.stringMatching(/^user-queue-kv-app-dpl_/),
      projectId: project.id,
      queueName: 'emails',
    });
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
    const eventNames = events.map((e: any) => e.event);

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
        const deleteCalls = fetchMock.mock.calls.filter((args: unknown[]) => {
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
        const targetedNewWorker = deleteCalls.some((args: unknown[]) => {
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
    const deleteCalls = fetchMock.mock.calls.filter((args: unknown[]) => {
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
  });
});

function buildStaticDeployForm(opts: {
  type: 'spa' | 'static';
  assets?: Record<string, string>;
}): FormData {
  const form = new FormData();
  const assetConfig =
    opts.type === 'spa'
      ? { not_found_handling: 'single-page-application' }
      : { not_found_handling: '404-page' };
  form.append('manifest', JSON.stringify({ version: 3, bindings: {}, assetConfig }));
  if (opts.assets) {
    for (const [path, content] of Object.entries(opts.assets)) {
      form.append(`asset:${path}`, new Blob([content]));
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
    const done = events.find((e: any) => e.event === 'done') as any;
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

    // Verify ISR cache entries were written to KV (packed binary format)
    const { value: homeValue, metadata: homeMeta } = await env.ISR_CACHE.getWithMetadata<{
      s: number;
      c: number;
      t: number;
    }>(`${project.id}/isr/__index__`, 'arrayBuffer');
    expect(homeValue).not.toBeNull();
    // Unpack: [4-byte header len][headers JSON][body]
    const homeView = new DataView(homeValue!);
    const homeHeaderLen = homeView.getUint32(0, true);
    const homeBody = new TextDecoder().decode(new Uint8Array(homeValue!, 4 + homeHeaderLen));
    expect(homeBody).toBe('<html>Prerendered</html>');
    expect(homeMeta?.s).toBe(200);
    expect(homeMeta?.t).toBe(3600);

    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/about`,
      'arrayBuffer',
    );
    expect(aboutValue).not.toBeNull();

    // Verify deployment is live
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('live');
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

    // /about should have ISR entry
    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/about`,
      'arrayBuffer',
    );
    expect(aboutValue).not.toBeNull();

    // /private should NOT have ISR entry
    const { value: privateValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/private`,
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
    const data = events.find((e: any) => e.event === 'done') as any;

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
    const data = (await res.json()) as { needed: string[]; total: number; skipped: number };
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
    // Simulate a KV/R2 deployment: store a serving manifest so preflight
    // knows assets are in KV/R2 (not WfP)
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
    const data = (await res.json()) as { needed: string[]; total: number; skipped: number };
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

    // CF session should have received the COMPLETE manifest (merged)
    expect(sessionManifest).toBeDefined();
    expect(Object.keys(sessionManifest!).sort()).toEqual(['/app.js', '/index.html']);
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
      const data = (await res.json()) as { needed: string[]; total: number; skipped: number };
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
      const data = (await res.json()) as { needed: string[]; total: number; skipped: number };
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
      const staticDone = staticEvents.find((e: any) => e.event === 'done');
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
        needed: string[];
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
      const done = events.find((e: any) => e.event === 'done');
      expect(done).toBeDefined();
      // Should not have errored with AssetHashMissError
      const error = events.find((e: any) => e.event === 'error');
      expect(error).toBeUndefined();
    });
  });
});
