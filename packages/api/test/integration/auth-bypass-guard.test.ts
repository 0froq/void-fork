import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv, clearTables, createTestUser, type TestEnv } from './helpers.ts';

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

describe('DEV_AUTH_BYPASS production guard', () => {
  it('ignores DEV_AUTH_BYPASS when PLATFORM_ENV is production', async () => {
    await createTestUser(env.db, 'bypass-user');

    const res = await app.fetch(new Request('http://localhost/me'), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
      PLATFORM_ENV: 'production',
    });
    expect(res.status).toBe(401);
  });

  it('allows DEV_AUTH_BYPASS when PLATFORM_ENV is not production', async () => {
    await createTestUser(env.db, 'bypass-user');

    const res = await app.fetch(new Request('http://localhost/me'), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
    });
    expect(res.status).toBe(200);
  });
});
