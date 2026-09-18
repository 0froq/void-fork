import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import {
  importLegacyAuthentication,
  stageLoginConfiguration,
} from '../../src/auth/configuration.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import { app } from '../../src/index.ts';
import { platformAuthAttempts, platformLoginConnections } from '../../src/schema.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;
let authorization: URL;
let callbackCount: number;
const origin = 'https://api.example.com';
const issuer = 'https://identity.login-example.com';
const verifier = 'a'.repeat(64);
beforeAll(async () => {
  env = await setupEnv();
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKey = keys.privateKey;
  jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'login-key', use: 'sig' };
});
afterAll(teardownEnv);
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await clearTables(env.db);
  await importLegacyAuthentication(env.db, env);
  await stageLoginConfiguration(
    env.db,
    env,
    { id: 'company', kind: 'oidc', label: 'Company SSO', clientId: 'client', issuer },
    'client-secret',
    null,
  );
  await env.db
    .update(platformLoginConnections)
    .set({ enabled: true, active_revision: 1 })
    .where(eq(platformLoginConnections.id, 'company'));
  callbackCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['ES256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      }
      if (url === `${issuer}/token`) {
        callbackCount++;
        const body = options?.body as URLSearchParams;
        expect(await createCodeChallenge(body.get('code_verifier')!)).toBe(
          authorization.searchParams.get('code_challenge'),
        );
        expect(body.get('redirect_uri')).toBe(`${origin}/auth/callback`);
        const idToken = await new SignJWT({
          nonce: authorization.searchParams.get('nonce'),
          email: 'employee@example.com',
          email_verified: true,
        })
          .setIssuer(issuer)
          .setAudience('client')
          .setSubject('employee')
          .setIssuedAt()
          .setExpirationTime('5m')
          .setProtectedHeader({ alg: 'ES256', kid: 'login-key' })
          .sign(privateKey);
        return Response.json({
          token_type: 'Bearer',
          access_token: 'upstream-token',
          id_token: idToken,
        });
      }
      if (url === `${issuer}/keys`) {
        return Response.json({ keys: [jwk] });
      }
      throw new Error('Unexpected outbound request');
    }),
  );
});

async function start() {
  const url = new URL('/auth/login', origin);
  url.searchParams.set('provider', 'company');
  url.searchParams.set('redirect', 'http://localhost:3456/callback?state=cli-state');
  url.searchParams.set('code_challenge', await createCodeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  const response = await app.fetch(new Request(url), env);
  expect(response.status).toBe(302);
  authorization = new URL(response.headers.get('Location')!);
  return {
    state: authorization.searchParams.get('state')!,
    cookie: response.headers.get('Set-Cookie')!.split(';')[0]!,
  };
}
function callback(flow: { state: string; cookie: string }) {
  return app.fetch(
    new Request(`${origin}/auth/callback?code=provider-code&state=${flow.state}`, {
      headers: { Cookie: flow.cookie },
    }),
    env,
  );
}

describe('configured platform login routes', () => {
  it('completes OIDC browser authentication and a separate one-time PKCE CLI exchange', async () => {
    const flow = await start();
    const response = await callback(flow);
    expect(response.status).toBe(302);
    const redirected = new URL(response.headers.get('Location')!);
    expect(redirected.searchParams.has('token')).toBe(false);
    const exchange = () =>
      app.fetch(
        new Request(`${origin}/auth/cli/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: redirected.searchParams.get('code'),
            state: 'cli-state',
            code_verifier: verifier,
          }),
        }),
        env,
      );
    const tokenResponse = await exchange();
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json<{ token: string }>();
    const whoami = await app.fetch(
      new Request(`${origin}/me`, { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );
    expect(whoami.status).toBe(200);
    expect((await exchange()).status).toBe(400);
    expect((await callback(flow)).status).toBe(400);
    expect(callbackCount).toBe(1);
  });

  it('does not consume a legitimate flow when another browser sends its state', async () => {
    const flow = await start();
    expect((await callback({ ...flow, cookie: 'void_platform_auth=another-browser' })).status).toBe(
      400,
    );
    expect(await env.db.select().from(platformAuthAttempts)).toHaveLength(1);
    expect((await callback(flow)).status).toBe(302);
  });

  it('rejects a callback if its connection was disabled while the user authenticated', async () => {
    const flow = await start();
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'company'));
    expect((await callback(flow)).status).toBe(401);
    expect(callbackCount).toBe(0);
  });

  it('rejects redemption after a method is disabled, even if the login callback already completed', async () => {
    const response = await callback(await start());
    const redirected = new URL(response.headers.get('Location')!);
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'company'));
    const exchange = await app.fetch(
      new Request(`${origin}/auth/cli/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: redirected.searchParams.get('code'),
          state: 'cli-state',
          code_verifier: verifier,
        }),
      }),
      env,
    );
    expect(exchange.status).toBe(400);
  });

  it('shows dynamic admin login methods and never falls back to disabled methods', async () => {
    const response = await app.fetch(new Request(`${origin}/admin/login`), env);
    expect(await response.text()).toContain('Sign in with Company SSO');
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'github'));
    expect((await app.fetch(new Request(`${origin}/admin/login/github`), env)).status).toBe(404);
  });
});
