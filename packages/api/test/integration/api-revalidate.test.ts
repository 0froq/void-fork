import { hashOriginalUrl } from '@voidcloud/isr-shared';
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
import { hmacSignState } from '../../src/auth/hmac.ts';
import app from '../../src/index.ts';
import { domains } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

function isrKey(projectId: string, deploymentId: string, normalizedPath: string): string {
  return `${projectId}/isr/v2/${deploymentId}/${normalizedPath}`;
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /projects/:id/revalidate', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/revalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/revalidate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for non-owner', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${other.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 without paths or all', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
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

  it('purges rewrite-variant KV entries and edge URLs for the requested path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Direct-hit and rewrite-variant entries for the same pathname.
    const directKey = isrKey(project.id, deployment.id, 'en/docs');
    // Token computed with the same hash dispatch uses (FNV-1a 64-bit hex).
    // Purger only knows the hashed token; original URL is not recoverable.
    const originalUrl = `https://${project.slug}.void.app/docs`;
    const token = hashOriginalUrl(originalUrl);
    const variantKey = `${directKey}#rw=${token}`;
    await env.ISR_CACHE.put(directKey, 'direct');
    await env.ISR_CACHE.put(variantKey, 'rewritten');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/en/docs'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await env.ISR_CACHE.get(directKey)).toBeNull();
    expect(await env.ISR_CACHE.get(variantKey)).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // Direct-hit edge URLs (html + json).
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/en/docs?__void=json&__void_isr=${deployment.id}`,
    );
    // Rewrite-variant edge URLs (reconstructed from the decoded token).
    expect(
      purgedFiles.some((u) =>
        u.startsWith(
          `https://${project.slug}.void.app/en/docs?__void_isr=${deployment.id}&__void_orig=`,
        ),
      ),
    ).toBe(true);
  });

  it('purges specific paths from KV and edge cache', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Seed ISR cache entries
    await env.ISR_CACHE.put(isrKey(project.id, deployment.id, '__index__'), 'home');
    await env.ISR_CACHE.put(isrKey(project.id, deployment.id, 'about'), 'about');
    await env.ISR_CACHE.put(isrKey(project.id, deployment.id, 'blog/hello'), 'blog post');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/', '/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);

    // Verify purged entries are gone
    const home = await env.ISR_CACHE.get(isrKey(project.id, deployment.id, '__index__'));
    expect(home).toBeNull();
    const about = await env.ISR_CACHE.get(isrKey(project.id, deployment.id, 'about'));
    expect(about).toBeNull();
    // blog/hello should still exist
    const blog = await env.ISR_CACHE.get(isrKey(project.id, deployment.id, 'blog/hello'));
    expect(blog).not.toBeNull();

    // Verify edge cache purge was called with correct URLs
    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/?__void_isr=${deployment.id}`);
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toHaveLength(4);
  });

  it('also purges the database active deployment when routing KV is stale', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const previousDeployment = await createTestDeployment(env.db, project.id, 'live');
    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    await env.ROUTING.put(project.slug, JSON.stringify({ version: previousDeployment.id }));
    await env.ISR_CACHE.put(isrKey(project.id, previousDeployment.id, 'about'), 'previous');
    await env.ISR_CACHE.put(isrKey(project.id, activeDeployment.id, 'about'), 'active');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // `purged` reflects the caller's unique path entries, not the raw count of
    // KV keys deleted across drift-hedge namespaces.
    const driftBody = (await res.json()) as { purged: number };
    expect(driftBody.purged).toBe(1);
    expect(await env.ISR_CACHE.get(isrKey(project.id, activeDeployment.id, 'about'))).toBeNull();
    expect(await env.ISR_CACHE.get(isrKey(project.id, previousDeployment.id, 'about'))).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${activeDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${previousDeployment.id}`,
    );
    // Both deployment ids are also purged with the __void=json variant
    // (pages protocol edge cache key).
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${activeDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${previousDeployment.id}`,
    );
  });

  it('also purges the routing deployment when the database active deployment is stale', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const databaseActiveDeployment = await createTestDeployment(env.db, project.id, 'live');
    const routingDeployment = await createTestDeployment(env.db, project.id, 'failed');
    const fetchMock = mockCfApi();

    await env.ROUTING.put(project.slug, JSON.stringify({ version: routingDeployment.id }));
    await env.ISR_CACHE.put(isrKey(project.id, databaseActiveDeployment.id, 'about'), 'database');
    await env.ISR_CACHE.put(isrKey(project.id, routingDeployment.id, 'about'), 'routing');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const driftBody = (await res.json()) as { purged: number };
    expect(driftBody.purged).toBe(1);
    expect(
      await env.ISR_CACHE.get(isrKey(project.id, databaseActiveDeployment.id, 'about')),
    ).toBeNull();
    expect(await env.ISR_CACHE.get(isrKey(project.id, routingDeployment.id, 'about'))).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${databaseActiveDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${routingDeployment.id}`,
    );
  });

  it('purges all ISR entries with all: true', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Seed ISR cache entries
    await env.ISR_CACHE.put(isrKey(project.id, deployment.id, '__index__'), 'home');
    await env.ISR_CACHE.put(isrKey(project.id, deployment.id, 'about'), 'about');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);

    // Verify all ISR entries are gone
    const home = await env.ISR_CACHE.get(isrKey(project.id, deployment.id, '__index__'));
    expect(home).toBeNull();
    const about = await env.ISR_CACHE.get(isrKey(project.id, deployment.id, 'about'));
    expect(about).toBeNull();

    // Verify edge cache purge with correct pathnames derived from KV keys
    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/?__void_isr=${deployment.id}`);
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
  });

  it('includes custom domain URLs in edge cache purge', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Add a custom domain
    await env.db.insert(domains).values({
      id: 'dom_test1',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-test-id',
      status: 'active',
    });

    await env.ISR_CACHE.put(isrKey(project.id, deployment.id, 'about'), 'about');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // slug domain + custom domain, HTML + JSON each = 4 URLs
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${deployment.id}`);
    expect(purgedFiles).toContain(
      `https://example.com/about?__void=json&__void_isr=${deployment.id}`,
    );
    expect(purgedFiles).toHaveLength(4);
  });

  it('batches purge requests for >100 URLs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Create 51 paths × 2 variants (HTML+JSON) = 102 URLs → needs 2 batches
    const paths: Array<string> = [];
    for (let i = 0; i < 51; i++) {
      const path = `/page-${i}`;
      paths.push(path);
      await env.ISR_CACHE.put(isrKey(project.id, deployment.id, `page-${i}`), `content-${i}`);
    }

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths }),
      }),
      env,
    );

    expect(res.status).toBe(200);

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    // 51 paths × 2 variants = 102 URLs → 2 batches (100 + 2)
    expect(purgeCalls.length).toBe(2);

    const batch1 = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    const batch2 = JSON.parse(purgeCalls[1][1]!.body as string).files as Array<string>;
    expect(batch1).toHaveLength(100);
    expect(batch2).toHaveLength(2);
  });

  it('succeeds even if edge cache purge fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    mockCfApi({
      purgeCache: () =>
        Response.json({ success: false, errors: [{ code: 1000, message: 'fail' }] }),
    });

    await env.ISR_CACHE.put(isrKey(project.id, deployment.id, 'about'), 'about');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    // Should still succeed — KV deletion happened, edge purge is best-effort
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(1);

    // KV entry should still be deleted
    const about = await env.ISR_CACHE.get(isrKey(project.id, deployment.id, 'about'));
    expect(about).toBeNull();
  });

  it('purges each hostname under its own routing version', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const oldDeployment = await createTestDeployment(env.db, project.id, 'live');
    const newDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // slug moved to NEW, active_deployment_id is NEW (set by the second
    // `createTestDeployment` call). The domain:* routing entry is stuck
    // on OLD — this mirrors the partial-failure deploy branch in
    // `deploy.ts` where the slug routing write succeeded but the
    // per-domain routing loop failed and the deploy stayed "live".
    await env.ROUTING.put(project.slug, JSON.stringify({ version: newDeployment.id }));
    await env.ROUTING.put('domain:example.com', JSON.stringify({ version: oldDeployment.id }));
    await env.db.insert(domains).values({
      id: 'dom_drift',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-drift',
      status: 'active',
    });

    await env.ISR_CACHE.put(isrKey(project.id, newDeployment.id, 'about'), 'new');
    await env.ISR_CACHE.put(isrKey(project.id, oldDeployment.id, 'about'), 'old');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const driftBody = (await res.json()) as { purged: number };
    expect(driftBody.purged).toBe(1);

    // Both deployment namespaces are scanned and deleted in KV
    expect(await env.ISR_CACHE.get(isrKey(project.id, newDeployment.id, 'about'))).toBeNull();
    expect(await env.ISR_CACHE.get(isrKey(project.id, oldDeployment.id, 'about'))).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;

    // Slug hostname uses NEW version (both HTML + JSON variants)
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${newDeployment.id}`,
    );
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void=json&__void_isr=${newDeployment.id}`,
    );
    // Custom domain uses OLD version
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${oldDeployment.id}`);
    expect(purgedFiles).toContain(
      `https://example.com/about?__void=json&__void_isr=${oldDeployment.id}`,
    );
    // Custom domain also picks up the active_deployment_id hedge (NEW)
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${newDeployment.id}`);
    expect(purgedFiles).toContain(
      `https://example.com/about?__void=json&__void_isr=${newDeployment.id}`,
    );
  });

  it('falls back to the legacy namespace for versionless routing entries', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const activeDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    // Versionless routing entry (pre-v2 legacy shape).
    await env.ROUTING.put(project.slug, JSON.stringify({ projectId: project.id }));
    await env.ISR_CACHE.put(isrKey(project.id, 'legacy', 'about'), 'legacy-hit');
    await env.ISR_CACHE.put(isrKey(project.id, activeDeployment.id, 'about'), 'active');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    // Both the 'legacy' namespace (matching dispatch's `?? 'legacy'`)
    // and the active_deployment_id hedge are purged from KV.
    expect(await env.ISR_CACHE.get(isrKey(project.id, 'legacy', 'about'))).toBeNull();
    expect(await env.ISR_CACHE.get(isrKey(project.id, activeDeployment.id, 'about'))).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void_isr=legacy`);
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${activeDeployment.id}`,
    );
  });

  it('matches dispatch nullish semantics when routing.version is an empty string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    // Dispatch's `routing.version ?? 'legacy'` yields `''` (not `'legacy'`)
    // when `version` is the empty string — nullish coalescing only catches
    // null/undefined. Dispatch would write ISR under `<projectId>/isr/v2//<path>`
    // (the double slash is intentional — empty deployment-id segment).
    await env.ROUTING.put(project.slug, JSON.stringify({ version: '' }));
    await env.ISR_CACHE.put(isrKey(project.id, '', 'about'), 'stored-under-empty-id');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/revalidate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(1);
    // The empty-deployment-id key must be deleted — this is the key dispatch
    // actually wrote, so the resolver + prefix logic must target it exactly.
    expect(await env.ISR_CACHE.get(isrKey(project.id, '', 'about'))).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    // Edge cache purge uses `__void_isr=` (empty value) for the empty-id set,
    // matching the cache key dispatch would have used when serving.
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void_isr=`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void=json&__void_isr=`);
  });
});

describe('POST /internal/revalidate/:id', () => {
  it('purges each hostname under its own routing version (HMAC auth)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const oldDeployment = await createTestDeployment(env.db, project.id, 'live');
    const newDeployment = await createTestDeployment(env.db, project.id, 'live');
    const fetchMock = mockCfApi();

    await env.ROUTING.put(project.slug, JSON.stringify({ version: newDeployment.id }));
    await env.ROUTING.put('domain:example.com', JSON.stringify({ version: oldDeployment.id }));
    await env.db.insert(domains).values({
      id: 'dom_internal_drift',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-internal-drift',
      status: 'active',
    });

    await env.ISR_CACHE.put(isrKey(project.id, newDeployment.id, 'about'), 'new');
    await env.ISR_CACHE.put(isrKey(project.id, oldDeployment.id, 'about'), 'old');

    const token = await hmacSignState(project.id, env.JWT_SECRET);
    const res = await app.fetch(
      new Request(`http://localhost/internal/revalidate/${project.id}`, {
        method: 'POST',
        headers: {
          'x-void-internal': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ paths: ['/about'] }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const hmacBody = (await res.json()) as { purged: number };
    expect(hmacBody.purged).toBe(1);
    expect(await env.ISR_CACHE.get(isrKey(project.id, newDeployment.id, 'about'))).toBeNull();
    expect(await env.ISR_CACHE.get(isrKey(project.id, oldDeployment.id, 'about'))).toBeNull();

    const purgeCalls = fetchMock.mock.calls.filter(
      (call: Array<unknown>) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as Array<string>;
    expect(purgedFiles).toContain(
      `https://${project.slug}.void.app/about?__void_isr=${newDeployment.id}`,
    );
    expect(purgedFiles).toContain(`https://example.com/about?__void_isr=${oldDeployment.id}`);
  });
});
