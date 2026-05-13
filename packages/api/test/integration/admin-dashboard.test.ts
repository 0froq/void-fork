import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vite-plus/test';
import { app } from '../../src/index.ts';
import { deployments, invitations, projects, users } from '../../src/schema.ts';
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
let manifestCounter = 0;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  env.REQUESTS_DATASET = 'void_requests';
});

function req(path: string, cookie?: string, init?: RequestInit): Response | Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (cookie) {
    headers.Cookie = `admin_token=${cookie}`;
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }),
    env,
  );
}

describe('auth middleware', () => {
  test('redirects to /admin/login without cookie', async () => {
    const res = await req('/admin/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });

  test('redirects to /admin/login with invalid cookie', async () => {
    const res = await req('/admin/', 'invalid-token');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });

  test('returns 403 for non-admin user', async () => {
    const user = await createTestUser(env.db, 'regular');
    const res = await req('/admin/', user.adminJwt);
    expect(res.status).toBe(403);
  });

  test('allows admin user', async () => {
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/', admin.adminJwt);
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/ (dashboard)', () => {
  test('renders dashboard with stats and projects', async () => {
    const admin = await createTestUser(env.db, 'admin1', 'github', undefined, 'free', 'admin');
    await createTestUser(env.db, 'user1');
    await createTestProject(env.db, admin.id, 'dash-proj');
    mockCfApi();

    const res = await req('/admin/', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Dashboard');
    expect(html).toContain('Users');
    expect(html).toContain('Projects');
    expect(html).toContain('dash-proj');
    expect(html).toContain('Top 10 Projects');
    vi.restoreAllMocks();
  });

  test('stat cards link to views', async () => {
    const admin = await createTestUser(env.db, 'admin1b', 'github', undefined, 'free', 'admin');
    mockCfApi();
    const res = await req('/admin/', admin.adminJwt);
    const html = await res.text();
    expect(html).toContain('href="/admin/users"');
    expect(html).toContain('href="/admin/projects"');
    expect(html).toContain('href="/admin/deployments"');
    vi.restoreAllMocks();
  });

  test('renders top projects sorted by recent site traffic', async () => {
    const admin = await createTestUser(env.db, 'admin1c', 'github', undefined, 'free', 'admin');
    const ownerA = await createTestUser(env.db, 'owner-a');
    const ownerB = await createTestUser(env.db, 'owner-b');
    const alpha = await createTestProject(env.db, ownerA.id, 'alpha');
    const beta = await createTestProject(env.db, ownerB.id, 'beta');

    mockCfApi({
      analyticsQuery: () =>
        Response.json({
          data: [
            {
              blob1: beta.id,
              requests: 420,
              bandwidth_bytes: 8192,
              last_seen: '2026-04-21 10:59:00',
            },
            {
              blob1: alpha.id,
              requests: 120,
              bandwidth_bytes: 2048,
              last_seen: '2026-04-21 10:58:00',
            },
          ],
        }),
    });

    const res = await req('/admin/', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    const betaIndex = html.indexOf('>beta<');
    const alphaIndex = html.indexOf('>alpha<');
    expect(betaIndex).toBeGreaterThan(-1);
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(betaIndex).toBeLessThan(alphaIndex);
    expect(html).toContain('420');
    expect(html).toContain('owner-b');

    vi.restoreAllMocks();
  });

  test('queries the configured requests dataset for top projects', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-dataset',
      'github',
      undefined,
      'free',
      'admin',
    );
    env.REQUESTS_DATASET = 'void_requests_staging';

    const fetchMock = mockCfApi({
      analyticsQuery: (_url, init) => {
        expect(init?.body).toContain('FROM void_requests_staging');
        return Response.json({ data: [] });
      },
    });

    const res = await req('/admin/', admin.adminJwt);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('GET /admin/users', () => {
  test('renders users list', async () => {
    const admin = await createTestUser(env.db, 'admin2', 'github', undefined, 'free', 'admin');
    await createTestUser(env.db, 'user2');

    const res = await req('/admin/users', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('user2');
  });

  test('paginates users', async () => {
    const admin = await createTestUser(env.db, 'admin2b', 'github', undefined, 'free', 'admin');
    // Create 20 more users to span 2 pages (PAGE_SIZE=20, +1 admin = 21)
    for (let i = 0; i < 20; i++) {
      await createTestUser(env.db, `paguser-${String(i).padStart(2, '0')}`);
    }

    const res1 = await req('/admin/users', admin.adminJwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(html1).toContain('1 / 2');
    expect(html1).toContain('?page=2');

    const res2 = await req('/admin/users?page=2', admin.adminJwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain('2 / 2');
  });

  test('searches users', async () => {
    const admin = await createTestUser(env.db, 'admin3', 'github', undefined, 'free', 'admin');
    await createTestUser(env.db, 'findable');
    await createTestUser(env.db, 'hidden');

    const res = await req('/admin/users?search=findable', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('findable');
    expect(html).not.toContain('hidden');
  });
});

describe('GET /admin/users/:id', () => {
  test('renders user detail', async () => {
    const admin = await createTestUser(env.db, 'admin4', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'detailuser');

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('detailuser');
    expect(html).toContain('Plan');
    expect(html).toContain('Suspension');
  });

  test('renders plan limits card', async () => {
    const admin = await createTestUser(env.db, 'admin4b', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'limitsuser');

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('>Plan<');
    expect(html).toContain('Requests / month');
    expect(html).toContain('3,000,000');
    expect(html).toContain('CPU ms / request');
    expect(html).toContain('Deploys / day');
    expect(html).toContain('D1 storage');
    expect(html).toContain('1 GB');
  });

  test('shows deploy count today', async () => {
    const admin = await createTestUser(env.db, 'admin4c', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'deploycountuser');
    const project = await createTestProject(env.db, user.id, 'dc-proj');
    await createTestDeployment(env.db, project.id, 'live');
    await createTestDeployment(env.db, project.id, 'live');

    // Mock CF API — the user detail page calls queryBatchProjectUsage which
    // fetches from Analytics Engine. Without a mock, the real fetch hangs in CI.
    mockCfApi();

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should show "2 / 100" (2 deploys today, free tier limit 100)
    expect(html).toContain('2 / 100');

    vi.restoreAllMocks();
  });
});

describe('POST /admin/users/:id/plan', () => {
  test('updates plan and redirects', async () => {
    const admin = await createTestUser(env.db, 'admin5', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'planuser');

    const body = new URLSearchParams({ plan: 'pro' });
    const res = await req(`/admin/users/${user.id}/plan`, admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/users/${user.id}`);
  });
});

describe('POST /admin/users/:id/suspend + unsuspend', () => {
  test('suspends and unsuspends via forms', async () => {
    const admin = await createTestUser(env.db, 'admin6', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'suspuser');
    const project = await createTestProject(env.db, user.id, 'susp-slug');
    await env.ROUTING.put(project.slug, JSON.stringify({ workerName: 'w', projectId: project.id }));

    // Suspend
    const suspBody = new URLSearchParams({ reason: 'test_reason' });
    const suspRes = await req(`/admin/users/${user.id}/suspend`, admin.adminJwt, {
      method: 'POST',
      body: suspBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(suspRes.status).toBe(302);

    const routingAfter = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfter.suspended).toBe('test_reason');

    // Unsuspend
    const unsuspRes = await req(`/admin/users/${user.id}/unsuspend`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(unsuspRes.status).toBe(302);

    const routingAfter2 = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfter2.suspended).toBeUndefined();
  });
});

describe('GET /admin/projects', () => {
  test('renders projects list', async () => {
    const admin = await createTestUser(env.db, 'admin7', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'projowner');
    await createTestProject(env.db, user.id, 'my-proj');

    const res = await req('/admin/projects', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('my-proj');
  });

  test('paginates projects', async () => {
    const admin = await createTestUser(env.db, 'admin7b', 'github', undefined, 'free', 'admin');
    // Create 21 projects to span 2 pages (PAGE_SIZE=20)
    for (let i = 0; i < 21; i++) {
      await createTestProject(env.db, admin.id, `pagproj-${String(i).padStart(2, '0')}`);
    }

    // Page 1: should have 20 projects and a Next link
    const res1 = await req('/admin/projects?page=1', admin.adminJwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(html1).toContain('1 / 2');
    expect(html1).toContain('?page=2');

    // Page 2: should have 1 project and no Next link
    const res2 = await req('/admin/projects?page=2', admin.adminJwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain('2 / 2');
    expect(html2).toContain('?page=1');
  });
});

describe('GET /admin/projects/:id', () => {
  test('renders project detail', async () => {
    const admin = await createTestUser(env.db, 'admin8', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'projowner2');
    const project = await createTestProject(env.db, user.id, 'detail-proj');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('detail-proj');
    expect(html).toContain('Resources');
    expect(html).toContain('Recent Deployments');
  });

  test('shows deployment error in project detail table', async () => {
    const admin = await createTestUser(env.db, 'admin8b', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'proj-err');
    await createTestDeployment(env.db, project.id, 'failed', 'cli', 'worker upload failed: 500');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('worker upload failed: 500');
  });

  test('links deployment IDs to detail page', async () => {
    const admin = await createTestUser(env.db, 'admin8c', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'proj-link');
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/admin/deployments/${deployment.id}`);
  });
});

describe('GET /admin/deployments', () => {
  test('renders deployments list', async () => {
    const admin = await createTestUser(env.db, 'admin10', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'deplowner');
    const project = await createTestProject(env.db, user.id, 'depl-proj');
    await createTestDeployment(env.db, project.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.3',
    });

    const res = await req('/admin/deployments', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Deployments');
    expect(html).toContain(`/admin/projects/${project.id}`);
    expect(html).toContain('live');
    expect(html).toContain('cli');
    expect(html).toContain('0.8.3');
  });

  test('shows error preview for failed deployments', async () => {
    const admin = await createTestUser(env.db, 'admin10b', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'errl-proj');
    await createTestDeployment(env.db, project.id, 'failed', 'cli', 'migration failed: syntax');

    const res = await req('/admin/deployments', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('migration failed: syntax');
  });

  test('searches deployments by CLI version', async () => {
    const admin = await createTestUser(env.db, 'admin10c', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'search-cli-version');
    await createTestDeployment(env.db, project.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.9',
    });

    const res = await req('/admin/deployments?search=0.8.9', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('search-cli-version');
    expect(html).toContain('0.8.9');
  });

  test('renders CLI version aggregate page', async () => {
    const admin = await createTestUser(env.db, 'admin10d', 'github', undefined, 'free', 'admin');
    const owner = await createTestUser(env.db, 'cli-owner');
    const projectA = await createTestProject(env.db, owner.id, 'cli-stats-a');
    const projectB = await createTestProject(env.db, owner.id, 'cli-stats-b');
    await createTestDeployment(env.db, projectA.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.3',
    });
    await createTestDeployment(env.db, projectB.id, 'failed', 'cli', undefined, {
      cliVersion: '0.8.3',
    });
    await createTestDeployment(env.db, projectB.id, 'live');

    const res = await req('/admin/cli-versions', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('CLI Versions');
    expect(html).toContain('Last 30 Days');
    expect(html).toContain('All Time');
    expect(html).toContain('0.8.3');
    expect(html).toContain('unknown');
  });

  test('paginates deployments', async () => {
    const admin = await createTestUser(env.db, 'admin11', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'pagdepl-proj');
    for (let i = 0; i < 21; i++) {
      await createTestDeployment(env.db, project.id, 'live');
    }

    const res1 = await req('/admin/deployments?page=1', admin.adminJwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(html1).toContain('1 / 2');
    expect(html1).toContain('?page=2');

    const res2 = await req('/admin/deployments?page=2', admin.adminJwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain('2 / 2');
    expect(html2).toContain('?page=1');
  });
});

describe('GET /admin/deployments/:id', () => {
  test('renders deployment detail', async () => {
    const admin = await createTestUser(env.db, 'admin12', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'depldetail-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.3',
    });

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(deployment.id);
    expect(html).toContain('depldetail-proj');
    expect(html).toContain('live');
    expect(html).toContain('cli');
    expect(html).toContain('CLI Version');
    expect(html).toContain('0.8.3');
  });

  test('shows error banner for failed deployment', async () => {
    const admin = await createTestUser(env.db, 'admin12b', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'errdetail-proj');
    const deployment = await createTestDeployment(
      env.db,
      project.id,
      'failed',
      'cli',
      'worker upload failed: internal error',
    );

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Error');
    expect(html).toContain('worker upload failed: internal error');
  });

  test('renders parsed manifest card', async () => {
    const admin = await createTestUser(env.db, 'admin12c', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'manifest-proj');
    const n = ++manifestCounter;
    const id = `dpl_manifest${n}`;
    const manifest = JSON.stringify({
      bindings: { d1: ['DB'], kv: ['CACHE'] },
      migrations: { dialect: 'sqlite', pending: 1 },
      schedules: [{ name: 'sync', cron: '0 * * * *' }],
    });
    await env.db.insert(deployments).values({
      id,
      project_id: project.id,
      status: 'live',
      manifest,
    });

    const res = await req(`/admin/deployments/${id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Manifest');
    expect(html).toContain('D1');
    expect(html).toContain('DB');
    expect(html).toContain('KV');
    expect(html).toContain('CACHE');
    expect(html).toContain('sqlite');
    expect(html).toContain('1 pending');
    expect(html).toContain('sync');
    expect(html).toContain('0 * * * *');
    expect(html).toContain('Raw JSON');
  });

  test('returns 404 for unknown deployment', async () => {
    const admin = await createTestUser(env.db, 'admin13', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/deployments/dpl_nonexistent', admin.adminJwt);
    expect(res.status).toBe(404);
  });

  test('shows cancel button for active deployment', async () => {
    const admin = await createTestUser(env.db, 'admin12d', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'active-deploy-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'uploading');

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Deploy Control');
    expect(html).toContain('Cancel Deploy');
    expect(html).toContain(`/admin/deployments/${deployment.id}/cancel`);
  });
});

describe('POST /admin/deployments/:id/cancel', () => {
  test('cancels active deployment and redirects to detail', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-cancel1',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'cancel-admin-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'uploading');

    const res = await req(`/admin/deployments/${deployment.id}/cancel`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/deployments/${deployment.id}`);

    const rows = await env.db.select().from(deployments);
    const canceling = rows.find((d) => d.id === deployment.id);
    expect(canceling?.status).toBe('canceling');
    expect(canceling?.error_message).toBe('canceled by admin');
  });
});

describe('GET /admin/login', () => {
  test('renders login page without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/admin/login'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Void Admin');
    expect(html).toContain('Google');
  });
});

describe('GET /admin/logout', () => {
  test('clears cookie and redirects', async () => {
    const admin = await createTestUser(env.db, 'admin9', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/logout', admin.adminJwt);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('admin_token=');
  });
});

describe('POST /admin/projects/:id/delete', () => {
  test('deletes project and redirects to list', async () => {
    mockCfApi();
    const admin = await createTestUser(env.db, 'admin-pdel1', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'projdel-owner');
    const project = await createTestProject(env.db, user.id, 'del-proj');
    await createTestDeployment(env.db, project.id, 'live');

    const res = await req(`/admin/projects/${project.id}/delete`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/projects');

    // Verify project is gone from DB
    const remaining = await env.db.select().from(projects);
    expect(remaining.find((p) => p.id === project.id)).toBeUndefined();
    vi.restoreAllMocks();
  });

  test('returns 404 for unknown project', async () => {
    const admin = await createTestUser(env.db, 'admin-pdel2', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/projects/proj_nonexistent/delete', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(404);
  });

  test('shows delete button on project detail page', async () => {
    const admin = await createTestUser(env.db, 'admin-pdel3', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'delbtn-proj');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Danger Zone');
    expect(html).toContain('Delete Project');
    expect(html).toContain(`/admin/projects/${project.id}/delete`);
  });
});

describe('POST /admin/users/:id/delete', () => {
  test('deletes user and cascades to projects, redirects to list', async () => {
    mockCfApi();
    const admin = await createTestUser(env.db, 'admin-udel1', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'delusertarget');
    const project1 = await createTestProject(env.db, user.id, 'udel-proj1');
    const project2 = await createTestProject(env.db, user.id, 'udel-proj2');
    await createTestDeployment(env.db, project1.id, 'live');
    await createTestDeployment(env.db, project2.id, 'live');

    const res = await req(`/admin/users/${user.id}/delete`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/users');

    // Verify user and projects are gone
    const remainingUsers = await env.db.select().from(users);
    expect(remainingUsers.find((u) => u.id === user.id)).toBeUndefined();
    const remainingProjects = await env.db.select().from(projects);
    expect(remainingProjects.find((p) => p.id === project1.id)).toBeUndefined();
    expect(remainingProjects.find((p) => p.id === project2.id)).toBeUndefined();
    vi.restoreAllMocks();
  });

  test('returns 404 for unknown user', async () => {
    const admin = await createTestUser(env.db, 'admin-udel2', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/users/user_nonexistent/delete', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(404);
  });

  test('shows delete button on user detail page', async () => {
    const admin = await createTestUser(env.db, 'admin-udel3', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'delbtnuser');
    await createTestProject(env.db, user.id, 'ubtn-proj');

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Danger Zone');
    expect(html).toContain('Delete User');
    expect(html).toContain(`/admin/users/${user.id}/delete`);
    expect(html).toContain('1 project(s)');
  });
});

describe('GET /admin/deployments/:id/logs', () => {
  test('returns logs from Analytics Engine for a live deployment', async () => {
    const admin = await createTestUser(env.db, 'admin-logs1', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'logs-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    mockCfApi({
      analyticsQuery: () =>
        Response.json({
          data: [
            {
              outcome: 'ok',
              logData: '[{"timestamp":1709312585000,"level":"error","message":"test error"}]',
              exceptionData: '[]',
              url: 'https://logs-proj.void.app/',
              method: 'GET',
              statusCode: '200',
              ts: 1709312585000,
            },
          ],
        }),
    });

    const res = await req(`/admin/deployments/${deployment.id}/logs`, admin.adminJwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ outcome: string; logs: Array<unknown> }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0].outcome).toBe('ok');
    expect(json.data[0].logs).toHaveLength(1);
    vi.restoreAllMocks();
  });

  test('returns 404 for unknown deployment', async () => {
    const admin = await createTestUser(env.db, 'admin-logs2', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/deployments/dpl_unknown/logs', admin.adminJwt);
    expect(res.status).toBe(404);
  });
});

describe('GET /admin/deployments/:id (logs section)', () => {
  test('renders runtime logs section for live deployment', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-logsui',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'logsui-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Runtime Logs');
    expect(html).toContain('Live Tail');
    expect(html).toContain('log-entries');
  });

  test('does not render logs section for failed deployment', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-logsui2',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'logsui2-proj');
    const deployment = await createTestDeployment(
      env.db,
      project.id,
      'failed',
      'cli',
      'some error',
    );

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Runtime Logs');
  });
});

describe('GET /admin/signup-control', () => {
  test('renders signup control page with toggle off by default', async () => {
    const admin = await createTestUser(env.db, 'admin-sc1', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/signup-control', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Signup Control');
    expect(html).toContain('OFF (open)');
  });

  test('shows entries when they exist', async () => {
    const admin = await createTestUser(env.db, 'admin-sc2', 'github', undefined, 'free', 'admin');
    await env.ROUTING.put(
      'signup:allowlist',
      JSON.stringify([{ type: 'github', pattern: 'octocat', note: 'Test' }]),
    );
    const res = await req('/admin/signup-control', admin.adminJwt);
    const html = await res.text();
    expect(html).toContain('octocat');
    expect(html).toContain('Test');
    await env.ROUTING.delete('signup:allowlist');
  });

  test('nav bar includes Signup link', async () => {
    const admin = await createTestUser(env.db, 'admin-sc2b', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/signup-control', admin.adminJwt);
    const html = await res.text();
    expect(html).toContain('href="/admin/signup-control"');
  });
});

describe('POST /admin/signup-control/toggle', () => {
  test('toggles restriction on and off', async () => {
    const admin = await createTestUser(env.db, 'admin-sc3', 'github', undefined, 'free', 'admin');

    // Toggle ON
    const res1 = await req('/admin/signup-control/toggle', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res1.status).toBe(302);
    expect(await env.ROUTING.get('signup:enabled')).toBe('true');

    // Toggle OFF
    const res2 = await req('/admin/signup-control/toggle', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res2.status).toBe(302);
    expect(await env.ROUTING.get('signup:enabled')).toBe('false');

    await env.ROUTING.delete('signup:enabled');
  });
});

describe('POST /admin/signup-control/add + delete', () => {
  test('adds and removes entries', async () => {
    const admin = await createTestUser(env.db, 'admin-sc4', 'github', undefined, 'free', 'admin');

    // Add entry
    const addBody = new URLSearchParams({ type: 'github', pattern: 'testuser', note: 'Test' });
    const addRes = await req('/admin/signup-control/add', admin.adminJwt, {
      method: 'POST',
      body: addBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(addRes.status).toBe(302);

    const raw = await env.ROUTING.get('signup:allowlist');
    const entries = JSON.parse(raw!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ type: 'github', pattern: 'testuser', note: 'Test' });

    // Delete entry
    const delBody = new URLSearchParams({ index: '0' });
    const delRes = await req('/admin/signup-control/delete', admin.adminJwt, {
      method: 'POST',
      body: delBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(delRes.status).toBe(302);

    const rawAfter = await env.ROUTING.get('signup:allowlist');
    expect(JSON.parse(rawAfter!)).toHaveLength(0);

    await env.ROUTING.delete('signup:allowlist');
  });

  test('rejects invalid entry type', async () => {
    const admin = await createTestUser(env.db, 'admin-sc5', 'github', undefined, 'free', 'admin');

    const body = new URLSearchParams({ type: 'invalid', pattern: 'test' });
    const res = await req('/admin/signup-control/add', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(400);
  });

  test('rejects delete with out-of-bounds index', async () => {
    const admin = await createTestUser(env.db, 'admin-sc6', 'github', undefined, 'free', 'admin');

    const body = new URLSearchParams({ index: '99' });
    const res = await req('/admin/signup-control/delete', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/invitations/send', () => {
  test('invites multiple comma or whitespace separated emails', async () => {
    const admin = await createTestUser(env.db, 'admin-inv1', 'github', undefined, 'free', 'admin');
    await env.ROUTING.delete('signup:allowlist');

    const body = new URLSearchParams({
      email: 'abc@x.com, zyc@gmail.com\nThird@Example.com  abc@x.com',
    });
    const res = await req('/admin/invitations/send', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });

    expect(res.status).toBe(302);

    const rows = await env.db.select().from(invitations);
    expect(rows.map((row) => row.email).sort()).toEqual([
      'abc@x.com',
      'third@example.com',
      'zyc@gmail.com',
    ]);

    const raw = await env.ROUTING.get('signup:allowlist');
    expect(JSON.parse(raw!)).toEqual([
      { type: 'email', pattern: 'abc@x.com', note: 'Invited by admin-inv1' },
      { type: 'email', pattern: 'zyc@gmail.com', note: 'Invited by admin-inv1' },
      { type: 'email', pattern: 'third@example.com', note: 'Invited by admin-inv1' },
    ]);

    await env.ROUTING.delete('signup:allowlist');
  });

  test('rejects a batch if any email is already invited', async () => {
    const admin = await createTestUser(env.db, 'admin-inv2', 'github', undefined, 'free', 'admin');
    await env.ROUTING.delete('signup:allowlist');

    const firstBody = new URLSearchParams({ email: 'existing@example.com' });
    const firstRes = await req('/admin/invitations/send', admin.adminJwt, {
      method: 'POST',
      body: firstBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(firstRes.status).toBe(302);

    const secondBody = new URLSearchParams({
      email: 'new@example.com, existing@example.com',
    });
    const secondRes = await req('/admin/invitations/send', admin.adminJwt, {
      method: 'POST',
      body: secondBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });

    expect(secondRes.status).toBe(400);
    const rows = await env.db.select().from(invitations);
    expect(rows.map((row) => row.email)).toEqual(['existing@example.com']);

    await env.ROUTING.delete('signup:allowlist');
  });
});

describe('GET /signup-restricted', () => {
  test('renders private beta page without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/signup-restricted'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Private Beta');
    expect(html).toContain('Sorry, we are still in private beta');
  });
});
