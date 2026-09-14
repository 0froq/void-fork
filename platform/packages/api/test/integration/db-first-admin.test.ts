import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createUserForPlatform } from '../../src/db.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterAll(async () => {
  await teardownEnv();
});

describe('self-hosted first owner bootstrap', () => {
  it('atomically grants exactly the first self-hosted user admin access', async () => {
    const create = (id: string) =>
      env.db.transaction((tx) =>
        createUserForPlatform(
          tx as unknown as typeof env.db,
          'github',
          id,
          `user-${id}`,
          null,
          'installation-a1b2c3d4',
        ),
      );
    const users = await Promise.all([create('one'), create('two')]);
    expect(users.filter((user) => user.role === 'admin')).toHaveLength(1);
    expect(users.filter((user) => user.role === 'user')).toHaveLength(1);
    expect(users.every((user) => user.plan === 'custom')).toBe(true);
  });

  it('preserves Void Cloud user defaults when no installation id is set', async () => {
    const user = await env.db.transaction((tx) =>
      createUserForPlatform(
        tx as unknown as typeof env.db,
        'github',
        'hosted',
        'hosted-user',
        null,
      ),
    );
    expect(user.role).toBe('user');
    expect(user.plan).toBe('free');
  });
});
