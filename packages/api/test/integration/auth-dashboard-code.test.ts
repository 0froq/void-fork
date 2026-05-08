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
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createMockExecutionContext,
  seedOAuthNonce,
  JWT_SECRET,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
const executionCtx = createMockExecutionContext();

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  env.DASHBOARD_URL = 'https://dash.staging.void.cloud';
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildSignedState(redirect: string): Promise<string> {
  const stateData = JSON.stringify({ redirect, nonce: 'oauth-test-nonce', provider: 'github' });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, JWT_SECRET);
  return `${stateEncoded}.${signature}`;
}

function mockGitHubApi() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'test-gh-token' });
    }

    if (url === 'https://api.github.com/user') {
      return Response.json({ id: 12345, login: 'dashboard-user', email: null });
    }

    if (url === 'https://api.github.com/user/emails') {
      return Response.json([
        { email: 'dashboard-user@example.com', primary: true, verified: true },
      ]);
    }

    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe('dashboard auth code exchange', () => {
  it('redirects dashboards with a single-use auth code and preserves login_nonce', async () => {
    const redirect = 'https://dash.staging.void.cloud/auth/callback?login_nonce=dashboard-nonce';
    const state = await buildSignedState(redirect);
    await seedOAuthNonce(env.db, 'oauth-test-nonce');
    vi.stubGlobal('fetch', mockGitHubApi());

    const callbackRes = await app.fetch(
      new Request(`http://localhost/auth/callback?code=provider-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=oauth-test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(callbackRes.status).toBe(302);
    const location = new URL(callbackRes.headers.get('Location')!);
    expect(location.origin).toBe('https://dash.staging.void.cloud');
    expect(location.pathname).toBe('/auth/callback');
    expect(location.searchParams.get('login_nonce')).toBe('dashboard-nonce');
    expect(location.searchParams.has('token')).toBe(false);

    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const exchangeRes = await app.fetch(
      new Request('http://localhost/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      env,
      executionCtx,
    );

    expect(exchangeRes.status).toBe(200);
    await expect(exchangeRes.json()).resolves.toMatchObject({ token: expect.any(String) });

    const replayRes = await app.fetch(
      new Request('http://localhost/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      env,
      executionCtx,
    );
    expect(replayRes.status).toBe(400);
  });
});
