import { PLATFORM_DISABLED_KEY } from '@void/platform';
import { sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects health checks while the platform is disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    try {
      const res = await app.fetch(new Request('http://localhost/health'), env);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Platform disabled' });
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('verifies a self-hosted installation through its database claim', async () => {
    await env.db.execute(sql`
      CREATE TABLE "__void_platform_installation" (
        "singleton" boolean PRIMARY KEY,
        "installation_id" text NOT NULL
      )
    `);
    await env.db.execute(sql`
      INSERT INTO "__void_platform_installation" ("singleton", "installation_id")
      VALUES (true, 'installation-id')
    `);
    try {
      const healthy = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'installation-id',
      });
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ status: 'ok' });

      const wrongDatabase = await app.fetch(new Request('http://localhost/health'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'another-installation',
      });
      expect(wrongDatabase.status).toBe(503);
      expect(await wrongDatabase.json()).toEqual({ status: 'unhealthy' });
    } finally {
      await env.db.execute(sql`DROP TABLE "__void_platform_installation"`);
    }
  });
});
