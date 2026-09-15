import { afterAll, beforeAll, beforeEach, expect, test } from 'vite-plus/test';
import { app } from '../../src/index.ts';
import { operatorEvents } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let token: string;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const user = await createTestUser(env.db, 'audit-admin', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, user);
});

function request(path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

test('previews and reads produce no audit or configuration writes', async () => {
  await env.ROUTING.put('signup:enabled', 'false');
  const res = await request('/signup/restrict', { dryRun: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ dryRun: true, action: 'signup.restrict' });
  expect(await env.ROUTING.get('signup:enabled')).toBe('false');
  expect((await request('/signup')).status).toBe(200);
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
});

test('records actor, target, and success without recording credentials', async () => {
  const res = await request('/signup/restrict', {});
  expect(res.status).toBe(200);
  expect(res.headers.get('X-Void-Audit-Id')).toBeTruthy();
  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    login: 'audit-admin',
    action: 'signup/restrict',
    status: 'success',
    http_status: 200,
  });
  expect(JSON.stringify(events)).not.toContain(token);
  const page = await request('/system/events?limit=1');
  expect(await page.json()).toMatchObject({ total: 1, limit: 1, page: 1 });
});

test('records failed validation as a failed mutation attempt', async () => {
  const res = await request('/signup/allow', { type: 'invalid', pattern: 'anything' });
  expect(res.status).toBe(400);
  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ status: 'failed', http_status: 400 });
});
