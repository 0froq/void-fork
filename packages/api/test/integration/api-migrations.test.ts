import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import app from '../../src/index';
import { resources } from '../../src/schema';
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /projects/:id/migrations', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/proj_fake/migrations'), env);
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong user', async () => {
    const alice = await createTestUser(env.db, 'alice-mig');
    const bob = await createTestUser(env.db, 'bob-mig');
    const project = await createTestProject(env.db, alice.id, 'alice-mig-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/migrations`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns empty applied when no D1 resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-d1-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/migrations`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: [] });
  });

  it('returns applied migrations from remote D1', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-mig-app');

    // Insert a D1 resource
    await env.db.insert(resources).values({
      id: 'res_mig1',
      project_id: project.id,
      type: 'd1',
      cf_id: 'd1-mig-uuid',
      binding_name: 'DB',
    });

    mockCfApi({
      queryD1: () =>
        cfSuccess([
          {
            results: [
              { name: '001_create.sql', applied_at: '2025-01-01T00:00:00Z' },
              { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
            ],
          },
        ]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/migrations`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      applied: [
        { name: '001_create.sql', applied_at: '2025-01-01T00:00:00Z' },
        { name: '002_alter.sql', applied_at: '2025-01-02T00:00:00Z' },
      ],
    });
  });
});
