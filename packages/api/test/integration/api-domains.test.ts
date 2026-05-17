import { eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import app from '../../src/index.ts';
import { domains } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  type TestEnv,
} from './helpers.ts';

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

describe('POST /projects/:id/domains', () => {
  it('adds a custom domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-app');
    const fetchMock = mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-123',
          hostname: 'app.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.app.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.app.example.com',
            value: 'ownership-v',
          },
        }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'app.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      hostname: string;
      status: string;
      cname_target: string;
      ownership_verification?: { name: string; value: string };
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    expect(body.id).toMatch(/^dom_/);
    expect(body.hostname).toBe('app.example.com');
    expect(body.status).toBe('pending');
    expect(body.cname_target).toBe('cname.void.app');
    expect(body.ownership_verification?.name).toBe('_cf-custom-hostname.app.example.com');
    expect(body.ssl_validation_records).toBeDefined();

    // Verify the CF request body has the TXT-DCV shape and does NOT include
    // `custom_metadata` — that field requires a paid Enterprise SSL-for-SaaS
    // add-on our account is not provisioned for, and sending it causes CF to
    // reject every create.
    const cfCreateCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames') && init?.method === 'POST';
    });
    expect(cfCreateCall).toBeDefined();
    const cfBody = JSON.parse((cfCreateCall![1] as RequestInit).body as string) as {
      hostname: string;
      ssl: { method: string; type: string };
    };
    expect(cfBody.ssl.method).toBe('txt');
    expect(cfBody).not.toHaveProperty('custom_metadata');
  });

  it('returns 404 for non-existent project', async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/domains', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'app.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
  });

  it('returns 403 when user does not own project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-domain');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bob.jwt}`,
        },
        body: JSON.stringify({ hostname: 'app.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('returns 409 for duplicate hostname', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dup-domain');
    mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-dup',
          hostname: 'taken.example.com',
          status: 'pending',
          ssl: { status: 'pending' },
        }),
    });

    // Insert existing domain
    await env.db.insert(domains).values({
      id: 'dom_existing',
      project_id: project.id,
      hostname: 'taken.example.com',
      cf_hostname_id: 'ch-existing',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'taken.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'hostname already in use' });
  });

  it('rejects void.app subdomains', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reject-vc');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'bad.void.app' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cannot use void.app subdomains' });
  });

  it('rejects invalid hostname format', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'invalid-host');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'not a hostname' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid hostname format' });
  });
});

describe('GET /projects/:id/domains', () => {
  it('lists domains for a project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'list-domain');

    await env.db.insert(domains).values({
      id: 'dom_1',
      project_id: project.id,
      hostname: 'a.example.com',
      cf_hostname_id: 'ch-1',
      status: 'active',
    });
    await env.db.insert(domains).values({
      id: 'dom_2',
      project_id: project.id,
      hostname: 'b.example.com',
      cf_hostname_id: 'ch-2',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ hostname: string; status: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].hostname).toBe('a.example.com');
    expect(body[1].hostname).toBe('b.example.com');
  });
});

describe('GET /projects/:id/domains/:domainId', () => {
  it('returns domain status from CF API', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'status-domain');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-status',
          hostname: 'status.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.status.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.status.example.com',
            value: 'ownership-v',
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_status',
      project_id: project.id,
      hostname: 'status.example.com',
      cf_hostname_id: 'ch-status',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_status`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hostname: string;
      status: string;
      ssl_status: string;
      ownership_verification?: { name: string; value: string };
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    expect(body.hostname).toBe('status.example.com');
    expect(body.status).toBe('pending');
    expect(body.ssl_status).toBe('pending_validation');
    expect(body.ownership_verification?.name).toBe('_cf-custom-hostname.status.example.com');
    expect(body.ssl_validation_records).toBeDefined();
  });

  it('activates domain and writes KV when CF reports active', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'activate-domain');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-active',
          hostname: 'active.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.active.example.com',
            value: 'ownership-v',
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_activate',
      project_id: project.id,
      hostname: 'active.example.com',
      cf_hostname_id: 'ch-active',
      status: 'pending',
    });

    // Seed KV routing for the slug
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-activate-domain', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_activate`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('active');

    // Verify DB was updated
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_activate'));
    expect(row?.status).toBe('active');

    // Verify KV routing entry was written
    const domainRouting = await env.ROUTING.get('domain:active.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-activate-domain',
      projectId: project.id,
    });
  });

  it('does not write KV routing when CF reports active hostname but SSL is still validating', async () => {
    // Defense-in-depth path: CF returned `status: 'active'` (e.g. carried over
    // from a prior active state), but `ssl.status` is `pending_validation` —
    // the rare "active hostname with SSL re-validation" window during cert
    // renewal. The CF for SaaS docs require `ssl.status === 'active'` before
    // serving production traffic, so the gate must keep the domain pending.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pending-ssl');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-pending-ssl',
          hostname: 'pending-ssl.example.com',
          status: 'active',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.pending-ssl.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_pending_ssl',
      project_id: project.id,
      hostname: 'pending-ssl.example.com',
      cf_hostname_id: 'ch-pending-ssl',
      status: 'pending',
    });

    // Seed slug routing so the activation path COULD theoretically write.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-pending-ssl', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_pending_ssl`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      ssl_status: string;
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    // Response status reflects the gate, not CF's raw status.
    expect(body.status).toBe('pending');
    expect(body.ssl_status).toBe('pending_validation');
    expect(body.ssl_validation_records).toBeDefined();

    // DB row must still be pending.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_pending_ssl'));
    expect(row?.status).toBe('pending');

    // Critical assertion: KV routing entry must NOT have been written.
    const domainRouting = await env.ROUTING.get('domain:pending-ssl.example.com');
    expect(domainRouting).toBeNull();
  });

  it('does not activate legacy HTTP-DCV hostnames even when CF reports active', async () => {
    // Regression: a custom hostname created before the switch to TXT DCV could
    // still be polled by the status endpoint. Its `ssl.method` is `http`, which
    // remains vulnerable to the wildcard-CNAME hijack the TXT switch closes,
    // so the activation gate must keep the domain pending until it's recreated
    // with TXT DCV.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-http');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-legacy-http',
          hostname: 'legacy-http.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_legacy_http',
      project_id: project.id,
      hostname: 'legacy-http.example.com',
      cf_hostname_id: 'ch-legacy-http',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-legacy-http', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_legacy_http`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_legacy_http'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:legacy-http.example.com')).toBeNull();
  });

  it('keeps domain pending when slug routing is absent', async () => {
    // Regression: CF reports active but the project has never been deployed,
    // so `project.slug` is missing from KV. Flipping the DB row to active
    // without writing `domain:<hostname>` would leave traffic 404ing forever
    // (the gate would no longer fire on subsequent polls). DB and KV must
    // stay in sync — both pending until the next poll, or until a deploy
    // populates the slug entry.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-slug-routing');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-no-slug',
          hostname: 'no-slug.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_no_slug',
      project_id: project.id,
      hostname: 'no-slug.example.com',
      cf_hostname_id: 'ch-no-slug',
      status: 'pending',
    });
    // Intentionally do NOT seed `project.slug` in ROUTING.

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_no_slug`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_no_slug'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:no-slug.example.com')).toBeNull();
  });
});

describe('DELETE /projects/:id/domains/:domainId', () => {
  it('removes a custom domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'remove-domain');
    const fetchMock = mockCfApi();

    await env.db.insert(domains).values({
      id: 'dom_remove',
      project_id: project.id,
      hostname: 'remove.example.com',
      cf_hostname_id: 'ch-remove',
      status: 'active',
    });

    // Seed KV routing for the domain
    await env.ROUTING.put('domain:remove.example.com', JSON.stringify({ projectId: project.id }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_remove`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    // Verify DB record deleted
    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_remove'));
    expect(row).toBeUndefined();

    // Verify KV routing entry deleted
    const domainRouting = await env.ROUTING.get('domain:remove.example.com');
    expect(domainRouting).toBeNull();

    // Verify CF API was called
    const deleteCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/custom_hostnames/ch-remove') && (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    expect(deleteCall).toBeDefined();
  });

  it('still deletes DB record and KV when CF hostname deletion fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-fail-domain');
    mockCfApi({
      deleteCustomHostname: () => {
        throw new Error('CF API down');
      },
    });

    await env.db.insert(domains).values({
      id: 'dom_cf_fail',
      project_id: project.id,
      hostname: 'cf-fail.example.com',
      cf_hostname_id: 'ch-cf-fail',
      status: 'active',
    });

    await env.ROUTING.put('domain:cf-fail.example.com', JSON.stringify({ projectId: project.id }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_cf_fail`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings: Array<string> };
    expect(body.ok).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('CF API down');

    // DB record should still be deleted
    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_cf_fail'));
    expect(row).toBeUndefined();

    // KV routing entry should still be deleted
    const routing = await env.ROUTING.get('domain:cf-fail.example.com');
    expect(routing).toBeNull();
  });

  it('returns 404 for non-existent domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-domain');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_nonexistent`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(404);
  });
});
