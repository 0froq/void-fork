import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  createDeployment,
  updateDeploymentStatus,
  markDeploymentRetained,
  setActiveDeployment,
  setAppliedMigrations,
} from '../../src/db';
import app from '../../src/index';
import { users } from '../../src/schema';
import { domains, resources } from '../../src/schema';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  type TestEnv,
} from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GET /projects', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects'), env);
    expect(res.status).toBe(401);
  });

  it('returns 401 when user has been deleted', async () => {
    const user = await createTestUser(env.db);
    await env.db.delete(users).where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'user not found' });
  });

  it('returns 403 when user is admin-suspended', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account suspended' });
  });

  it('allows usage-suspended user to list projects', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('returns empty array when no projects', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns only the authenticated user's projects", async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    await createTestProject(env.db, alice.id, 'alice-app');
    await createTestProject(env.db, bob.id, 'bob-app');

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${alice.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const projects = (await res.json()) as Array<{ slug: string }>;
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe('alice-app');
  });
});

describe('GET /projects/:id', () => {
  it('returns project for the owner', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'my-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBe(project.id);
    expect(body.slug).toBe('my-app');
  });

  it('returns 403 when user does not own the project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /projects', () => {
  it('creates project with valid slug', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'my-app' }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      slug: string;
      user_id: string;
    };
    expect(body.slug).toBe('my-app');
    expect(body.user_id).toBe(user.id);
  });

  it('rejects missing slug', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid slug format', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'UPPER-CASE' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'slug must be lowercase alphanumeric with dashes',
    });
  });

  it('rejects short slug for free tier users', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'abc' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'short slugs (5 characters or fewer) require a paid plan',
    });
  });

  it('allows short slug for paid tier users', async () => {
    const user = await createTestUser(env.db, 'paiduser', 'github', undefined, 'solo');

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'abc' }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe('abc');
  });

  it('rejects duplicate slug', async () => {
    const user = await createTestUser(env.db);
    await createTestProject(env.db, user.id, 'taken-slug');

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'taken-slug' }),
      }),
      env,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'slug already taken' });
  });
});

describe('GET /projects/:id/deployments', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_test1/deployments'),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/deployments', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when not the project owner', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-project');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns empty array when no deployments', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<unknown>;
      activeDeploymentId: string | null;
    };
    expect(body.deployments).toEqual([]);
    expect(body.activeDeploymentId).toBeNull();
  });

  it('returns deployments with source field', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const d1 = await createDeployment(env.db, project.id, null, 'manual');
    await updateDeploymentStatus(env.db, d1.id, 'live');
    const d2 = await createDeployment(env.db, project.id, null, 'ci');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{ id: string; source: string | null; status: string }>;
      activeDeploymentId: string | null;
    };
    expect(body.deployments).toHaveLength(2);

    const byId = Object.fromEntries(body.deployments.map((d) => [d.id, d]));
    expect(byId[d1.id].source).toBe('manual');
    expect(byId[d1.id].status).toBe('live');
    expect(byId[d2.id].source).toBe('ci');
    expect(byId[d2.id].status).toBe('pending');
  });
});

describe('POST /projects/:id/rollback', () => {
  it('rolls back to a retained deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-app');

    // Create two deployments, both retained and live
    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe(d1.id);
    expect(body.migrationDiff).toEqual([]);

    // Verify KV routing updated
    const routing = (await env.ROUTING.get(project.slug, 'json')) as { workerName: string };
    expect(routing.workerName).toBe(`user-rollback-app-${d1.id}`);
  });

  it('returns 400 for non-retained deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'evicted-app');

    const d1 = await createDeployment(env.db, project.id, null);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    // retained defaults to false

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'deployment not retained (worker script evicted)' });
  });

  it('returns 404 for deployment from another project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const projectA = await createTestProject(env.db, alice.id, 'alice-roll');
    const projectB = await createTestProject(env.db, bob.id, 'bob-roll');

    const d1 = await createDeployment(env.db, projectB.id, null);
    await markDeploymentRetained(env.db, d1.id, true);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${projectA.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${alice.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'deployment not found' });
  });

  it('returns migrationDiff when rolling back past migrations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'migrate-roll');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    await setAppliedMigrations(env.db, d1.id, ['001_init.sql']);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setAppliedMigrations(env.db, d2.id, [
      '001_init.sql',
      '002_add_email.sql',
      '003_add_roles.sql',
    ]);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        // Rolling back to d1 drops 002/003 from the target's known
        // migrations while D1 still has them — destructive rollback. The
        // caller must echo the exact set of migrations that make up the
        // server-computed diff (currentActive minus target) as
        // `allowDestructive`; a mismatch is rejected with 400.
        body: JSON.stringify({
          deploymentId: d1.id,
          allowDestructive: ['002_add_email.sql', '003_add_roles.sql'],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { migrationDiff: Array<string> };
    expect(body.migrationDiff).toEqual(['002_add_email.sql', '003_add_roles.sql']);
  });

  it('updates custom domain KV entries on rollback', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-roll');

    // Insert an active domain
    await env.db.insert(domains).values({
      id: 'dom_rollback',
      project_id: project.id,
      hostname: 'rollback.example.com',
      cf_hostname_id: 'ch-rollback',
      status: 'active',
    });

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify domain KV routing updated
    const domainRouting = (await env.ROUTING.get('domain:rollback.example.com', 'json')) as {
      workerName: string;
    };
    expect(domainRouting.workerName).toBe(`user-domain-roll-${d1.id}`);
  });

  it('rollback resolves the proxy token once for both cron and queues (no duplicate CF fetch)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-and-queue-roll');
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;

    await env.db.insert(resources).values({
      id: 'res_mixed_roll',
      project_id: project.id,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Simulate a transient CF failure on the SECOND bindings call. With
    // the duplicate-fetch bug, cron sync succeeds on call 1 and commits
    // DO state; the queue fetch on call 2 then fails and the transaction
    // aborts — leaving cron partial. With the fix (single hoisted fetch),
    // the whole rollback succeeds on one healthy call.
    let bindingsCalls = 0;
    mockCfApi({
      listWorkerBindings: () => {
        bindingsCalls++;
        if (bindingsCalls === 1) {
          return cfSuccess([
            { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-d1-token' },
          ]);
        }
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10013, message: 'rate limited' }],
          }),
          { status: 429 },
        );
      },
    });

    const doCalls: Array<{ url: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, body: req.body ? await req.text() : null });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Exactly one CF bindings fetch for the rollback — the second call
    // is the one that used to introduce the extra failure point.
    expect(bindingsCalls).toBe(1);

    const sync = doCalls.find((c) => c.url === '/sync');
    expect(sync).toBeDefined();
    const payload = JSON.parse(sync!.body!) as { proxyToken: string };
    expect(payload.proxyToken).toBe('baked-d1-token');

    const queueRouting = (await env.ROUTING.get(queueRoutingKey, 'json')) as {
      proxyToken: string;
    };
    expect(queueRouting.proxyToken).toBe('baked-d1-token');
  });

  it('rollback cron sync uses the baked __VOID_PROXY_TOKEN from the target worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-roll');

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Return the exact token baked into d1's worker, so we can assert
    // rollback uses THIS value rather than re-deriving from JWT_SECRET.
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-into-d1-cron' }]),
    });

    const doCalls: Array<{ url: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, body: req.body ? await req.text() : null });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const sync = doCalls.find((c) => c.url === '/sync');
    expect(sync).toBeDefined();
    const payload = JSON.parse(sync!.body!) as { proxyToken: string; workerName: string };
    expect(payload.workerName).toBe(`user-cron-roll-${d1.id}`);
    expect(payload.proxyToken).toBe('baked-into-d1-cron');
  });

  it('updates queue KV entries on rollback using deterministic queue names', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-roll');
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;

    await env.db.insert(resources).values({
      id: 'res_queue_roll',
      project_id: project.id,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Worker bindings stored at deploy time include the exact
    // __VOID_PROXY_TOKEN that d1 expects — rollback must read THIS value
    // from CF rather than re-derive from the current JWT_SECRET, which
    // would 401 the worker if the secret has rotated since d1 was
    // deployed.
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([
          { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'token-baked-into-d1' },
        ]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const queueRouting = (await env.ROUTING.get(queueRoutingKey, 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
      proxyToken: string;
    };
    expect(queueRouting).toEqual({
      workerName: `user-queue-roll-${d1.id}`,
      projectId: project.id,
      queueName: 'emails',
      // The EXACT value from d1's worker bindings — not a freshly
      // hmacSignState(projectId, currentSecret) value.
      proxyToken: 'token-baked-into-d1',
    });
  });
});

describe('GET /projects/:id/logs', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/fake-id/logs'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/projects/nonexistent/logs', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's project", async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-logs');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns log data from analytics engine', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'my-app');

    const mockData = {
      data: [
        {
          outcome: 'ok',
          logData: JSON.stringify([{ level: 'log', message: ['hello'], timestamp: 1000 }]),
          exceptionData: '[]',
          url: 'https://my-app.void.app/api/test',
          method: 'GET',
          statusCode: '200',
          ts: Date.now() - 5000,
        },
      ],
    };

    mockCfApi({
      analyticsQuery: (_url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        expect(body).toContain('user-my-app');
        expect(body).toContain('ORDER BY timestamp DESC');
        return Response.json(mockData);
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ outcome: string; url: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      outcome: 'ok',
      url: 'https://my-app.void.app/api/test',
      method: 'GET',
      status: '200',
    });
  });

  it('returns analytics error details when the log query fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'broken-logs');

    mockCfApi({
      analyticsQuery: () => new Response('SQL compilation failed', { status: 400 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string; status: number; detail: string };
    expect(json).toMatchObject({
      error: 'log query failed',
      status: 400,
      detail: 'SQL compilation failed',
    });
  });

  it('rejects invalid since parameter', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-since');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?since=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});
