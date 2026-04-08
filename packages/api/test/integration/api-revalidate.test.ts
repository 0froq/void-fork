import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import app from '../../src/index';
import { domains } from '../../src/schema';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
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

  it('purges specific paths from KV and edge cache', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    // Seed ISR cache entries
    await env.ISR_CACHE.put(`${project.id}/isr/__index__`, 'home');
    await env.ISR_CACHE.put(`${project.id}/isr/about`, 'about');
    await env.ISR_CACHE.put(`${project.id}/isr/blog/hello`, 'blog post');

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
    const home = await env.ISR_CACHE.get(`${project.id}/isr/__index__`);
    expect(home).toBeNull();
    const about = await env.ISR_CACHE.get(`${project.id}/isr/about`);
    expect(about).toBeNull();
    // blog/hello should still exist
    const blog = await env.ISR_CACHE.get(`${project.id}/isr/blog/hello`);
    expect(blog).not.toBeNull();

    // Verify edge cache purge was called with correct URLs
    const purgeCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as string[];
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/?__void=json`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void=json`);
    expect(purgedFiles).toHaveLength(4);
  });

  it('purges all ISR entries with all: true', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    // Seed ISR cache entries
    await env.ISR_CACHE.put(`${project.id}/isr/__index__`, 'home');
    await env.ISR_CACHE.put(`${project.id}/isr/about`, 'about');

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
    const home = await env.ISR_CACHE.get(`${project.id}/isr/__index__`);
    expect(home).toBeNull();
    const about = await env.ISR_CACHE.get(`${project.id}/isr/about`);
    expect(about).toBeNull();

    // Verify edge cache purge with correct pathnames derived from KV keys
    const purgeCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as string[];
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/?__void=json`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void=json`);
  });

  it('includes custom domain URLs in edge cache purge', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    // Add a custom domain
    await env.db.insert(domains).values({
      id: 'dom_test1',
      project_id: project.id,
      hostname: 'example.com',
      cf_hostname_id: 'ch-test-id',
      status: 'active',
    });

    await env.ISR_CACHE.put(`${project.id}/isr/about`, 'about');

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
      (call: unknown[]) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    expect(purgeCalls.length).toBe(1);
    const purgedFiles = JSON.parse(purgeCalls[0][1]!.body as string).files as string[];
    // slug domain + custom domain, HTML + JSON each = 4 URLs
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about`);
    expect(purgedFiles).toContain(`https://${project.slug}.void.app/about?__void=json`);
    expect(purgedFiles).toContain('https://example.com/about');
    expect(purgedFiles).toContain('https://example.com/about?__void=json');
    expect(purgedFiles).toHaveLength(4);
  });

  it('batches purge requests for >100 URLs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    // Create 51 paths × 2 variants (HTML+JSON) = 102 URLs → needs 2 batches
    const paths: string[] = [];
    for (let i = 0; i < 51; i++) {
      const path = `/page-${i}`;
      paths.push(path);
      await env.ISR_CACHE.put(`${project.id}/isr/page-${i}`, `content-${i}`);
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
      (call: unknown[]) =>
        (call[1] as RequestInit | undefined)?.method === 'POST' &&
        (call[0] as string).includes('/purge_cache'),
    );
    // 51 paths × 2 variants = 102 URLs → 2 batches (100 + 2)
    expect(purgeCalls.length).toBe(2);

    const batch1 = JSON.parse(purgeCalls[0][1]!.body as string).files as string[];
    const batch2 = JSON.parse(purgeCalls[1][1]!.body as string).files as string[];
    expect(batch1).toHaveLength(100);
    expect(batch2).toHaveLength(2);
  });

  it('succeeds even if edge cache purge fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi({
      purgeCache: () =>
        Response.json({ success: false, errors: [{ code: 1000, message: 'fail' }] }),
    });

    await env.ISR_CACHE.put(`${project.id}/isr/about`, 'about');

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
    const about = await env.ISR_CACHE.get(`${project.id}/isr/about`);
    expect(about).toBeNull();
  });
});
