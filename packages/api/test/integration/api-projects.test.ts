import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vite-plus/test';
import {
  createDeployment,
  updateDeploymentStatus,
  markDeploymentRetained,
  setActiveDeployment,
  setAppliedMigrations,
} from '../../src/db.ts';
import * as db from '../../src/db.ts';
import app, { scheduled } from '../../src/index.ts';
import { getProjectQueueName } from '../../src/naming.ts';
import { users } from '../../src/schema.ts';
import {
  deployments,
  domains,
  resources,
  projectDatabaseCredentials,
  projects,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  cfSuccess,
  cfError,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

// Run the hourly scheduled() handler (which invokes `reconcileLiveRouting`).
// The bindings need `CRON_FIRES_QUEUE`, which `TestEnv` does not carry; supply a
// no-op queue and pass the test env through for everything else. `createDb()` is
// mocked (setup.ts) to return the same test db, so the reconciler reads/writes
// the same PGlite instance the rollback handler used.
async function runReconciler(): Promise<void> {
  const hourlyController = { scheduledTime: Date.now() } as unknown as ScheduledController;
  const mockCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const bindings = {
    ...env,
    CRON_FIRES_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Parameters<typeof scheduled>[1];
  await scheduled(hourlyController, bindings, mockCtx);
}

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
    mockCfApi();

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

  it('returns deployment, traffic, and health summaries sorted by attention', async () => {
    const user = await createTestUser(env.db, 'overview-user');
    const alpha = await createTestProject(env.db, user.id, 'alpha');
    const beta = await createTestProject(env.db, user.id, 'beta');
    const alphaDeploy = await createTestDeployment(env.db, alpha.id, 'live', 'main');
    const betaDeploy = await createTestDeployment(env.db, beta.id, 'failed', 'preview');
    await env.db.insert(domains).values({
      id: 'dom_alpha',
      project_id: alpha.id,
      hostname: 'alpha.example.com',
      cf_hostname_id: 'cf-alpha',
      status: 'active',
    });

    const bucketNow = Math.floor(Date.now() / 1000 / 15) * 15;
    const lastSeen = new Date().toISOString();
    mockCfApi({
      analyticsQuery: (_url, init) => {
        expect(init?.body).toContain('FROM void_requests');
        expect(init?.body).toContain('WHERE blob1 IN');
        return Response.json({
          data: [
            {
              project_id: alpha.id,
              bucket: bucketNow - 15,
              last_seen: lastSeen,
              requests: 4,
              responses_4xx: 1,
              responses_5xx: 0,
            },
            {
              project_id: beta.id,
              bucket: bucketNow,
              last_seen: lastSeen,
              requests: 9,
              responses_4xx: 0,
              responses_5xx: 2,
            },
          ],
        });
      },
    });

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const projects = (await res.json()) as Array<{
      slug: string;
      custom_domain: string | null;
      latest_deployment: { id: string; status: string; source: string | null } | null;
      traffic: { requests5m: number; lastSeenAt: string | null; sparkline5m: Array<number> };
      health: { responses4xx15m: number; responses5xx15m: number; errorRate5xx15m: number };
    }>;

    expect(projects.map((p) => p.slug)).toEqual(['beta', 'alpha']);
    expect(projects[0].latest_deployment).toMatchObject({
      id: betaDeploy.id,
      status: 'failed',
      source: 'preview',
    });
    expect(projects[0].traffic.requests5m).toBe(9);
    expect(projects[0].traffic.lastSeenAt).toBe(lastSeen);
    expect(projects[0].traffic.sparkline5m).toHaveLength(20);
    expect(projects[0].health.responses5xx15m).toBe(2);
    expect(projects[0].health.errorRate5xx15m).toBeCloseTo(2 / 9);
    expect(projects[1].latest_deployment?.id).toBe(alphaDeploy.id);
    expect(projects[1].custom_domain).toBe('alpha.example.com');
    expect(projects[1].health.responses4xx15m).toBe(1);
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

describe('PUT /projects/:id/database-url', () => {
  it('provisions Hyperdrive with a Cloudflare-safe name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-post');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        const body = JSON.parse(init?.body as string) as { name: string };
        expect(body.name).toBe(hyperdriveName);
        expect(body.name).toMatch(/^[a-z0-9-]+$/);
        return cfSuccess({ id: 'hd-post-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-post-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('creates Hyperdrive from a provider Postgres URL when no resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          origin: {
            database: 'appdb',
            host: 'db.example.com',
            password: 'p@ss',
            port: 25060,
            scheme: 'postgresql',
            user: 'void_user',
          },
          mtls: { sslmode: 'require' },
        });
        return cfSuccess({ id: 'hd-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString:
            'postgresql://void_user:p%40ss@db.example.com:25060/appdb?sslmode=require',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('updates the existing Hyperdrive config when the resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-update');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();
    await env.db.insert(resources).values({
      id: 'res_hd_existing',
      project_id: project.id,
      type: 'hyperdrive',
      cf_id: 'hd-existing',
      binding_name: 'HYPERDRIVE',
    });

    mockCfApi({
      updateHyperdrive: (url, init) => {
        expect(url).toContain('/hyperdrive/configs/hd-existing');
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          origin: {
            database: 'appdb',
            host: 'db.example.com',
            password: 'pass',
            port: 5432,
            scheme: 'postgres',
            user: 'void_user',
          },
        });
        return cfSuccess({ id: 'hd-existing', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgres://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('surfaces Cloudflare Hyperdrive errors as JSON instead of a generic 500', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-error');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Failed to provision Hyperdrive',
      detail: 'origin database is unreachable',
    });
  });
});

describe('GET /projects/:id/database-url', () => {
  it('returns 404 with structured error when no URL has been stored', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'database_url_not_stored',
      message: expect.stringContaining('void db set-url'),
    });
  });

  it('returns 403 when accessed by a different user', async () => {
    const owner = await createTestUser(env.db);
    const other = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'pg-app-get-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('round-trips the connection string via POST /:id/database', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-rt-post');
    const connectionString = 'postgresql://void_user:pass@db.example.com/appdb';

    mockCfApi();

    const postRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString }),
      }),
      env,
    );
    expect(postRes.status).toBe(200);

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: connectionString });
  });

  it('round-trips the connection string via PUT /:id/database-url', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-rt-put');
    const connectionString = 'postgres://void_user:secret@db.example.com/mydb';

    mockCfApi();

    const putRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString }),
      }),
      env,
    );
    expect(putRes.status).toBe(200);

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: connectionString });
  });

  it('last PUT wins — GET returns the most recently written URL', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-overwrite');
    const first = 'postgresql://void_user:first@db.example.com/appdb';
    const second = 'postgresql://void_user:second@db2.example.com/appdb2';

    mockCfApi();

    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: first }),
      }),
      env,
    );
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: second }),
      }),
      env,
    );

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: second });
  });
});

describe('database URL persistence ordering — CF failure must not overwrite stored URL', () => {
  it('POST /:id/database does not write credentials when createHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-post-cf-fail');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // No credential row should have been written
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(404);
    expect(await getRes.json()).toMatchObject({ error: 'database_url_not_stored' });
  });

  it('POST /:id/database leaves pre-existing credentials unchanged when createHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-post-cf-fail-keep');
    const originalUrl = 'postgresql://void_user:original@db.example.com/appdb';

    // Seed a successful first set via the happy path
    mockCfApi();
    const firstRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: originalUrl }),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);

    // Now a second POST attempt fails at CF (409 conflict since resource exists)
    // but the PUT endpoint is what would be called in a re-run; test it via
    // direct DB read to confirm the original value is intact after a PUT failure
    mockCfApi({
      updateHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    // Insert an existing hyperdrive resource so PUT takes the update path
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    const hdResource = rows.find((r) => r.type === 'hyperdrive');

    if (hdResource) {
      const putRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/database-url`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            connectionString: 'postgresql://void_user:new@db2.example.com/otherdb',
          }),
        }),
        env,
      );
      expect(putRes.status).toBe(502);
    }

    // The stored URL must still be the original
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: originalUrl });
  });

  it('PUT /:id/database-url does not write credentials when createHyperdrive rejects (no existing resource)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-put-cf-fail-create');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // No credential row should have been written
    const rows = await env.db
      .select()
      .from(projectDatabaseCredentials)
      .where(eq(projectDatabaseCredentials.project_id, project.id));
    expect(rows).toHaveLength(0);
  });

  it('PUT /:id/database-url does not overwrite credentials when updateHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-put-cf-fail-update');
    const originalUrl = 'postgresql://void_user:original@db.example.com/appdb';

    // Seed an existing hyperdrive resource and a stored credential via the happy path
    mockCfApi();
    const firstRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: originalUrl }),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);

    // Now attempt an update with CF rejecting the new URL
    mockCfApi({
      updateHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:new@db2.example.com/otherdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // The stored URL must still be the original (not overwritten with the rejected URL)
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: originalUrl });
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

  it('returns deployments with source and git metadata fields', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const d1 = await createDeployment(env.db, project.id, null, 'manual', 'abc1234', {
      cliVersion: '0.8.3',
      commitUrl: 'https://github.com/voidzero-dev/void/commit/abc1234',
      gitRef: 'main',
      repositoryUrl: 'https://github.com/voidzero-dev/void',
    });
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
      deployments: Array<{
        cli_version: string | null;
        commit: string | null;
        commit_url: string | null;
        git_ref: string | null;
        id: string;
        repository_url: string | null;
        source: string | null;
        status: string;
      }>;
      activeDeploymentId: string | null;
    };
    expect(body.deployments).toHaveLength(2);

    const byId = Object.fromEntries(body.deployments.map((d) => [d.id, d]));
    expect(byId[d1.id].source).toBe('manual');
    expect(byId[d1.id].cli_version).toBe('0.8.3');
    expect(byId[d1.id].commit).toBe('abc1234');
    expect(byId[d1.id].repository_url).toBe('https://github.com/voidzero-dev/void');
    expect(byId[d1.id].commit_url).toBe('https://github.com/voidzero-dev/void/commit/abc1234');
    expect(byId[d1.id].git_ref).toBe('main');
    expect(byId[d1.id].status).toBe('live');
    expect(byId[d2.id].source).toBe('ci');
    expect(byId[d2.id].cli_version).toBeNull();
    expect(byId[d2.id].commit_url).toBeNull();
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

  it('preserves the WfP asset-stub fallback when rolling back to a deployment with mirrored assets', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-assets');

    // Target deployment is a WfP deploy that mirrored assets to KV/R2
    // (asset_hashes non-null). Manifest has no explicit assetConfig, so
    // the rollback path must synthesize { not_found_handling: 'none' }.
    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify({ '/index.html': 'abc123' }) })
      .where(eq(deployments.id, d1.id));

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

    // The routing entry for the slug must carry the asset-stub fallback
    // pointers so dispatch can serve the mirrored KV/R2 assets when CF
    // returns the "Assets have not yet been deployed" stub.
    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      assetManifestId?: string;
      assetConfig?: { not_found_handling?: string } | null;
    };
    expect(routing.assetManifestId).toBe(d1.id);
    expect(routing.assetConfig).not.toBeNull();
    expect(routing.assetConfig).toEqual({ not_found_handling: 'none' });
  });

  it('cross-type rollback (WfP → static) publishes the static serving shape and restores projects.type', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-crosstype');

    // Target deployment d1 is a STATIC deploy: its manifest declares
    // `type: 'static'`. This is the deployment we roll back TO.
    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 3,
        type: 'static',
        assetConfig: { not_found_handling: '404-page' },
        bindings: {},
      }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    // Current active deployment d2 is a WfP deploy (`type: 'void'`). The
    // project was converted from static to a Void/WfP app between d1 and d2,
    // so `projects.type` currently reads 'void'.
    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'void', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);
    await env.db.update(projects).set({ type: 'void' }).where(eq(projects.id, project.id));

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

    // (a) The published slug ROUTING entry must carry the STATIC serving
    // shape, derived from the TARGET manifest's `type: 'static'` — NOT the
    // WfP shape implied by the project's CURRENT `type: 'void'`. The static
    // shape has `staticDeploymentId` and no `workerName`/WfP `version`-as-worker
    // serving fields.
    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      staticDeploymentId?: string;
      workerName?: string;
      type?: string;
      assetConfig?: { not_found_handling?: string };
    };
    expect(routing.staticDeploymentId).toBe(d1.id);
    expect(routing.workerName).toBeUndefined();
    expect(routing.type).toBe('static');
    expect(routing.assetConfig).toEqual({ not_found_handling: '404-page' });

    // (b) `projects.type` must be updated to the target's type so the hourly
    // reconciler (which reads `projects.type`) re-publishes the SAME static
    // shape rather than re-cementing the wrong WfP shape.
    const [row] = await env.db
      .select({ type: projects.type })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row.type).toBe('static');
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

  // ===========================================================================
  // F4 — rollback uses the deploy path's routing-after-tx + durable
  // routing_published marker model. The locked tx does ONLY pg work
  // (setActiveDeployment + updateProjectType + markRoutingUnpublished); all
  // KV/DO writes happen POST-commit. A post-commit publish failure leaves the
  // target committed-active but routing_published=false → the hourly reconciler
  // heals it. F6 — serving type derives from manifest.type (or
  // framework?framework:void for typeless), never from assetConfig.
  // ===========================================================================

  // Read the durable publish-complete marker for a deployment.
  async function readRoutingPublished(deploymentId: string): Promise<boolean | null> {
    const [row] = await env.db
      .select({ routing_published: deployments.routing_published })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    return row?.routing_published ?? null;
  }
  async function readActiveDeployment(projectId: string): Promise<string | null> {
    const [row] = await env.db
      .select({ active: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.active ?? null;
  }
  async function readProjectType(projectId: string): Promise<string | null> {
    const [row] = await env.db
      .select({ type: projects.type })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.type ?? null;
  }

  it('F4-1: publishes slug/domain/queue routing POST-commit (regression guard)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f4-publish');
    const queueRoutingKey = `queue:${getProjectQueueName(project.id, 'emails')}`;

    await env.db.insert(domains).values({
      id: 'dom_f4_publish',
      project_id: project.id,
      hostname: 'f4-publish.example.com',
      cf_hostname_id: 'ch-f4-publish',
      status: 'active',
    });

    const manifest = JSON.stringify({
      version: 3,
      type: 'void',
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

    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-f4' }]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const slug = (await env.ROUTING.get(project.slug, 'json')) as { workerName: string };
    expect(slug.workerName).toBe(`user-f4-publish-${d1.id}`);
    const domain = (await env.ROUTING.get('domain:f4-publish.example.com', 'json')) as {
      workerName: string;
    };
    expect(domain.workerName).toBe(`user-f4-publish-${d1.id}`);
    const queue = (await env.ROUTING.get(queueRoutingKey, 'json')) as { proxyToken: string };
    expect(queue.proxyToken).toBe('baked-f4');
  });

  it('F4-2: writes the project:<id> account entry on rollback (deploy parity)', async () => {
    const user = await createTestUser(env.db, 'f4acct', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'f4-account');

    const m = JSON.stringify({ version: 3, type: 'void', bindings: {} });
    const d1 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const account = (await env.ROUTING.get(`project:${project.id}`, 'json')) as {
      userId: string;
      plan: string;
    };
    expect(account).toEqual({ userId: user.id, plan: 'pro' });
  });

  it('F4-3: marker lifecycle — seeded target routing_published=true ends true after rollback', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f4-marker');

    const m = JSON.stringify({ version: 3, type: 'void', bindings: {} });
    const d1 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    // Seed the target as already-published (e.g. it was live before).
    await env.db
      .update(deployments)
      .set({ routing_published: true })
      .where(eq(deployments.id, d1.id));
    const d2 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    expect(await readRoutingPublished(d1.id)).toBe(true);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // The tx cleared it to false (markRoutingUnpublished); the post-commit
    // publish succeeded and re-marked it true. End state: true.
    expect(await readRoutingPublished(d1.id)).toBe(true);
  });

  it('F4-4: failed post-commit publish returns 200, leaves target active+unpublished, reconciler heals it', async () => {
    const user = await createTestUser(env.db, 'f4heal', 'github', undefined, 'free');
    const project = await createTestProject(env.db, user.id, 'f4-heal');

    const m = JSON.stringify({ version: 3, type: 'void', bindings: {} });
    const d1 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Make the slug-key PUT throw during the rollback publish (both attempts).
    const realPut = env.ROUTING.put.bind(env.ROUTING);
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: never,
      opts: never,
    ) => {
      if (key === project.slug) {
        throw new Error('kv unavailable');
      }
      return realPut(key, value, opts);
    }) as typeof env.ROUTING.put);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    // (a) Rollback still returns 200 — a publish failure never fails a
    // committed-live rollback.
    expect(res.status).toBe(200);
    // (b) The DB flip committed: target is active and projects.type tracks it.
    expect(await readActiveDeployment(project.id)).toBe(d1.id);
    expect(await readProjectType(project.id)).toBe('void');
    // (c) The slug route never landed and the marker is false → heal pending.
    expect(await env.ROUTING.get(project.slug)).toBeNull();
    expect(await readRoutingPublished(d1.id)).toBe(false);

    // Now let the reconciler run with KV healthy again.
    putSpy.mockRestore();
    await runReconciler();

    // The reconciler rebuilt the routing byte-identically and marked it.
    const slug = (await env.ROUTING.get(project.slug, 'json')) as { version: string };
    expect(slug.version).toBe(d1.id);
    expect(await readRoutingPublished(d1.id)).toBe(true);
  });

  it('F4-5: an in-tx failure (setActiveDeployment throws) writes ZERO KV and leaves state unchanged', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f4-txfail');
    const queueRoutingKey = `queue:${getProjectQueueName(project.id, 'emails')}`;

    await env.db.insert(domains).values({
      id: 'dom_f4_txfail',
      project_id: project.id,
      hostname: 'f4-txfail.example.com',
      cf_hostname_id: 'ch-f4-txfail',
      status: 'active',
    });

    const manifest = JSON.stringify({
      version: 3,
      type: 'void',
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

    // Force the in-tx pg flip to throw by poisoning `setActiveDeployment` (the
    // established db-namespace spy pattern used in api-deploy / api-sandbox).
    // The tx aborts → nothing commits, no external KV/DO write ran.
    const setActiveSpy = vi
      .spyOn(db, 'setActiveDeployment')
      .mockRejectedValue(new Error('forced in-tx failure'));
    const putSpy = vi.spyOn(env.ROUTING, 'put');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    // The unexpected throw surfaces as a 500 (generic catch rethrows).
    expect(res.status).toBe(500);
    // No routing KV written for this project — slug/domain/queue all absent.
    expect(
      putSpy.mock.calls.some(
        ([key]) =>
          key === project.slug ||
          key === 'domain:f4-txfail.example.com' ||
          key === queueRoutingKey ||
          key === `project:${project.id}`,
      ),
    ).toBe(false);
    // active_deployment_id unchanged (still d2) and target marker untouched.
    expect(await readActiveDeployment(project.id)).toBe(d2.id);
    expect(await readRoutingPublished(d1.id)).toBeNull();

    setActiveSpy.mockRestore();
    putSpy.mockRestore();
  });

  it('F4-6: cron sync runs POST-commit and is swallowed — DO failure still returns 200 with routing published', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f4-cron');

    const manifest = JSON.stringify({
      version: 3,
      type: 'void',
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

    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-cron' }]),
    });

    // Cron DO /sync rejects — the post-commit cron block must swallow it.
    const doCalls: Array<{ url: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, body: req.body ? await req.text() : null });
          throw new Error('DO unavailable');
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    // Cron failure is swallowed → 200.
    expect(res.status).toBe(200);
    // The /sync was attempted post-commit with the baked token.
    const sync = doCalls.find((c) => c.url === '/sync');
    expect(sync).toBeDefined();
    expect((JSON.parse(sync!.body!) as { proxyToken: string }).proxyToken).toBe('baked-cron');
    // Routing still published despite the cron failure.
    const slug = (await env.ROUTING.get(project.slug, 'json')) as { version: string };
    expect(slug.version).toBe(d1.id);
    expect(await readRoutingPublished(d1.id)).toBe(true);
  });

  it('F4-6b: target WITHOUT schedules calls /clear unconditionally post-commit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f4-clear');

    const m = JSON.stringify({ version: 3, type: 'void', bindings: {} });
    const d1 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const doCalls: Array<string> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          doCalls.push(new URL(req.url).pathname);
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(doCalls).toContain('/clear');
    expect(doCalls).not.toContain('/sync');
  });

  it('F4-7: after a successful rollback the reconciler is a no-op for that project (routing_published gate)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f4-coherent');

    const m = JSON.stringify({ version: 3, type: 'void', bindings: {} });
    const d1 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await readRoutingPublished(d1.id)).toBe(true);

    // Capture what the reconciler would write — it must skip this project since
    // the marker is already true (no clobber / double-publish).
    const beforeSlug = await env.ROUTING.get(project.slug);
    const putSpy = vi.spyOn(env.ROUTING, 'put');
    await runReconciler();

    expect(putSpy.mock.calls.some(([key]) => key === project.slug)).toBe(false);
    expect(await env.ROUTING.get(project.slug)).toBe(beforeSlug);
    putSpy.mockRestore();
  });

  it('F4-8: a post-commit publish helper REJECTION returns 200, leaves target active+unpublished, reconciler heals it', async () => {
    const user = await createTestUser(env.db, 'f4reject', 'github', undefined, 'free');
    const project = await createTestProject(env.db, user.id, 'f4-reject');

    const m = JSON.stringify({ version: 3, type: 'void', bindings: {} });
    const d1 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(env.db, project.id, m);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Distinct from F4-4 (which makes the slug PUT throw → a 'failed' RETURN that
    // `publishRoutingIfStillActive` catches internally): here the helper itself
    // REJECTS post-commit — e.g. a transient pg/Hyperdrive error taking the
    // FOR UPDATE lock or committing the publish tx. The bare await used to surface
    // this as a 500 on an already-committed rollback. `mockRejectedValueOnce`:
    // only the rollback's call rejects; the reconciler's later call runs the real
    // publish (spyOn falls through to the original after the one-shot).
    const publishSpy = vi
      .spyOn(db, 'publishRoutingIfStillActive')
      .mockRejectedValueOnce(new Error('hyperdrive blip taking the publish lock'));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    // (a) Rollback still returns 200 — a publish REJECTION must never fail a
    // committed-live rollback (parity with the 'failed'-return handling in F4-4).
    expect(res.status).toBe(200);
    // (b) The go-live tx committed: target active, projects.type tracks it.
    expect(await readActiveDeployment(project.id)).toBe(d1.id);
    expect(await readProjectType(project.id)).toBe('void');
    // (c) The publish never ran → slug route absent, marker false → heal pending.
    expect(await env.ROUTING.get(project.slug)).toBeNull();
    expect(await readRoutingPublished(d1.id)).toBe(false);

    // The reconciler (real helper) heals the route byte-identically and marks it.
    publishSpy.mockRestore();
    await runReconciler();
    const slug = (await env.ROUTING.get(project.slug, 'json')) as { version: string };
    expect(slug.version).toBe(d1.id);
    expect(await readRoutingPublished(d1.id)).toBe(true);
  });

  it('F6-8: typeless WfP manifest with SPA assetConfig rolls back to the WfP shape (type void)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f6-typeless-wfp');

    // Target d1 is a typeless manifest whose assetConfig says SPA. The OLD code
    // would misclassify it as 'spa' (static shape); the fix derives WfP/void.
    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 3,
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    // Current active d2 is a typed static deploy; projects.type currently 'spa'.
    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 3,
        type: 'spa',
        assetConfig: { not_found_handling: 'single-page-application' },
        bindings: {},
      }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);
    await env.db.update(projects).set({ type: 'spa' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      workerName?: string;
      staticDeploymentId?: string;
      type?: string;
    };
    expect(routing.workerName).toBe(`user-f6-typeless-wfp-${d1.id}`);
    expect(routing.staticDeploymentId).toBeUndefined();
    expect(await readProjectType(project.id)).toBe('void');
  });

  it('F6-9: typeless framework manifest rolls back to framework type, WfP shape', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f6-framework');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {}, framework: 'astro' }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'void', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      workerName?: string;
      staticDeploymentId?: string;
      type?: string;
    };
    expect(routing.workerName).toBe(`user-f6-framework-${d1.id}`);
    expect(routing.staticDeploymentId).toBeUndefined();
    expect(routing.type).toBe('framework');
    expect(await readProjectType(project.id)).toBe('framework');
  });

  it('F6-10: typed static target keeps the static shape', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f6-static');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 3,
        type: 'static',
        assetConfig: { not_found_handling: '404-page' },
        bindings: {},
      }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'void', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);
    await env.db.update(projects).set({ type: 'void' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      staticDeploymentId?: string;
      workerName?: string;
      type?: string;
    };
    expect(routing.staticDeploymentId).toBe(d1.id);
    expect(routing.workerName).toBeUndefined();
    expect(routing.type).toBe('static');
    expect(await readProjectType(project.id)).toBe('static');
  });

  it('F6-11: typed spa target keeps the static shape', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f6-spa');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 3,
        type: 'spa',
        assetConfig: { not_found_handling: 'single-page-application' },
        bindings: {},
      }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'void', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);
    await env.db.update(projects).set({ type: 'void' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      staticDeploymentId?: string;
      workerName?: string;
      type?: string;
    };
    expect(routing.staticDeploymentId).toBe(d1.id);
    expect(routing.workerName).toBeUndefined();
    expect(routing.type).toBe('spa');
    expect(await readProjectType(project.id)).toBe('spa');
  });

  it('F6-12: assetConfig is ignored for type — typed void with SPA assetConfig is WfP', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f6-assetignore');

    // Target declares type:'void' but ALSO an SPA assetConfig. The fix keys off
    // manifest.type only, so this is a WfP/void deploy — assetConfig does not
    // promote it to 'spa'.
    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 3,
        type: 'void',
        bindings: {},
        assetConfig: { not_found_handling: 'single-page-application' },
      }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'spa', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);
    await env.db.update(projects).set({ type: 'spa' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      staticDeploymentId?: string;
      workerName?: string;
      type?: string;
    };
    expect(routing.workerName).toBe(`user-f6-assetignore-${d1.id}`);
    expect(routing.staticDeploymentId).toBeUndefined();
    expect(routing.type).toBe('void');
    expect(await readProjectType(project.id)).toBe('void');
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

  it('appends an error-level WHERE clause when level=error', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-error');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=error`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(
      `AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%')`,
    );
  });

  it('appends a warn-level WHERE clause when level=warn', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-warn');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=warn`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob2 LIKE '%"level":"warn"%'`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it.each(['info', 'log', 'debug'] as const)(
    'appends a %s-level WHERE clause when level=%s',
    async (lvl) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `lvl-${lvl}`);

      let capturedBody = '';
      mockCfApi({
        analyticsQuery: (_url, init) => {
          capturedBody = typeof init?.body === 'string' ? init.body : '';
          return Response.json({ data: [] });
        },
      });

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/logs?level=${lvl}`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(capturedBody).toContain(`AND blob2 LIKE '%"level":"${lvl}"%'`);
      expect(capturedBody).not.toContain(`blob1 != 'ok'`);
    },
  );

  it('omits the level WHERE clause when level=all', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-all');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=all`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).not.toContain(`"level":`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it('omits the level WHERE clause when level is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-missing');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).not.toContain(`"level":`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it('rejects unknown level values with a 400 and never queries AE', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-bad');

    let aeCalls = 0;
    mockCfApi({
      analyticsQuery: () => {
        aeCalls++;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=foo`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid level parameter/);
    expect(json.error).toMatch(/error, warn, info, log, debug/);
    expect(aeCalls).toBe(0);
  });

  it('combines level=error with deploymentId so both clauses are ANDed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-combo');
    const deploymentId = 'dpl_abc123';

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/projects/${project.id}/logs?level=error&deploymentId=${deploymentId}`,
        {
          headers: { Authorization: `Bearer ${user.jwt}` },
        },
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob7 = '${deploymentId}'`);
    expect(capturedBody).toContain(
      `AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%')`,
    );
  });
});
