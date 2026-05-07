import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import app from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestProjectSecret,
  mockCfApi,
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

function buildDeployForm(manifest: object): FormData {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append(
    'worker:index.js',
    new Blob(["export default { fetch() { return new Response('ok'); } }"]),
  );
  return form;
}

describe('manifest var / secret collision warning', () => {
  it('logs warning when manifest vars collide with project secrets', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'collision-app');
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'secret-value');
    mockCfApi();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
        body: buildDeployForm({
          version: 3,
          bindings: {},
          vars: { API_KEY: 'from-manifest' },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    await res.text();

    // Logger emits a structured JSON line via console.warn; the relevant
    // record carries `msg: 'var_secret_collisions'` and the colliding name
    // in `collisions`.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('var_secret_collisions'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('API_KEY'));
  });
});
