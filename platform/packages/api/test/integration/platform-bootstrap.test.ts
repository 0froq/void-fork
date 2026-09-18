import { eq, sql } from 'drizzle-orm';
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
import { AUTH_SETUP_PROOF_PREFIX } from '../../src/auth/bootstrap.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import { hashLoginProof, randomLoginProof } from '../../src/auth/proofs.ts';
import { app } from '../../src/index.ts';
import {
  platformAuthBootstrap,
  platformAuthSettings,
  platformLoginConnections,
  platformLoginRevisions,
  users,
} from '../../src/schema.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

const origin = 'https://api.example.com';
const issuer = 'https://identity.bootstrap-example.com';
const installationId = 'installation-bootstrap';
let env: TestEnv;
let code: string;
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;
let authorization: URL;
beforeAll(async () => {
  env = await setupEnv();
  await env.db.execute(
    sql`CREATE TABLE IF NOT EXISTS __void_platform_installation (singleton boolean PRIMARY KEY, installation_id text NOT NULL)`,
  );
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKey = keys.privateKey;
  jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'bootstrap-key', use: 'sig' };
});
afterAll(async () => {
  await env.db.execute(sql`DROP TABLE IF EXISTS __void_platform_installation`);
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  await env.db.execute(
    sql`INSERT INTO __void_platform_installation (singleton, installation_id) VALUES (true, ${installationId})`,
  );
  code = randomLoginProof();
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
        const body = options?.body as URLSearchParams;
        expect(body.get('client_secret')).toBe('oidc-bootstrap-secret');
        expect(await createCodeChallenge(body.get('code_verifier')!)).toBe(
          authorization.searchParams.get('code_challenge'),
        );
        const idToken = await new SignJWT({
          nonce: authorization.searchParams.get('nonce'),
          email: 'administrator@example.com',
          email_verified: true,
        })
          .setIssuer(issuer)
          .setAudience('client')
          .setSubject('administrator-subject')
          .setIssuedAt()
          .setExpirationTime('5m')
          .setProtectedHeader({ alg: 'ES256', kid: 'bootstrap-key' })
          .sign(privateKey);
        return Response.json({
          token_type: 'Bearer',
          access_token: 'temporary-provider-token',
          id_token: idToken,
        });
      }
      if (url === `${issuer}/keys`) {
        return Response.json({ keys: [jwk] });
      }
      throw new Error('Unexpected request, including any GitHub dependency');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
function bindings() {
  return {
    ...env,
    PLATFORM_INSTALLATION_ID: installationId,
    PLATFORM_AUTH_SETUP_TOKEN: 'setup-authority-fixture',
    PLATFORM_HEALTH_PROBE_TOKEN: 'health-probe-fixture',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  };
}
async function input(extra: Record<string, unknown> = {}) {
  return {
    connections: [
      {
        configuration: {
          id: 'company',
          kind: 'oidc',
          label: 'Company SSO',
          issuer,
          clientId: 'client',
        },
        clientSecret: 'oidc-bootstrap-secret',
      },
    ],
    administratorConnectionId: 'company',
    bootstrapCredentialHash: await hashLoginProof(code),
    admission: { mode: 'restricted' },
    protection: null,
    ...extra,
  };
}
async function initialize(
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
  key = 'setup-authority-fixture',
) {
  const body = JSON.stringify(await input(extra));
  const signature = await hmacSignState(
    `${AUTH_SETUP_PROOF_PREFIX}\n${installationId}\n${body}`,
    key,
  );
  return app.fetch(
    new Request(`${origin}/internal/platform/auth-initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Void-Auth-Setup': signature,
      },
      body,
    }),
    { ...bindings(), ...overrides },
  );
}
function form(path: string, values: Record<string, string>, cookie = '', requestOrigin = origin) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: requestOrigin,
        Cookie: cookie,
      },
      body: new URLSearchParams(values),
    }),
    bindings(),
  );
}
async function authenticateSetup() {
  const start = await form('/auth/bootstrap', { code });
  expect(start.status).toBe(302);
  authorization = new URL(start.headers.get('Location')!);
  const cookie = start.headers.get('Set-Cookie')!.split(';')[0]!;
  return app.fetch(
    new Request(
      `${origin}/auth/callback?code=provider-code&state=${authorization.searchParams.get('state')}`,
      { headers: { Cookie: cookie } },
    ),
    bindings(),
  );
}

describe('provider-independent first administrator setup', () => {
  it('does not accept health-probe authority or unverified database caching', async () => {
    expect((await initialize({}, {}, 'health-probe-fixture')).status).toBe(403);
    expect(await env.db.select().from(platformAuthSettings)).toHaveLength(0);
    expect((await initialize({}, { PLATFORM_AUTH_DATABASE_UNCACHED: undefined })).status).toBe(503);
    expect(await env.db.select().from(platformAuthSettings)).toHaveLength(0);
    expect((await initialize({}, { PLATFORM_TRAFFIC_STATE: 'staging' })).status).toBe(200);
  });

  it('requires the database claim to match the installing platform', async () => {
    await env.db.execute(
      sql`UPDATE __void_platform_installation SET installation_id = 'another-installation'`,
    );
    expect((await initialize()).status).toBe(403);
    expect(await env.db.select().from(users)).toHaveLength(0);
  });

  it('bootstraps an OIDC-only installation only after the owner reviews and confirms the identity', async () => {
    expect((await initialize()).status).toBe(200);
    expect((await initialize()).status).toBe(200);
    const discovery = await (
      await app.fetch(new Request(`${origin}/.well-known/void-platform`), bindings())
    ).json();
    expect(discovery).toMatchObject({
      schemaVersion: 3,
      authenticationProviders: [],
      authentication: { setupPending: true },
    });
    expect(await env.db.select().from(users)).toHaveLength(0);
    const rows = await env.db.select().from(platformLoginRevisions);
    expect(JSON.stringify(rows)).not.toContain('oidc-bootstrap-secret');
    expect(JSON.stringify(await env.db.select().from(platformAuthBootstrap))).not.toContain(code);
    expect(
      (await app.fetch(new Request(`${origin}/admin/login`), bindings())).headers.get('Location'),
    ).toBe('/setup');
    expect((await form('/auth/bootstrap', { code: randomLoginProof() })).status).toBe(403);
    expect(
      (await form('/auth/bootstrap', { code }, '', 'https://attacker.example.com')).status,
    ).toBe(403);
    const callback = await authenticateSetup();
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('administrator@example.com');
    expect(await env.db.select().from(users)).toHaveLength(0);
    const proofCookie = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('void_bootstrap_confirm='))!
      .split(';')[0]!;
    expect(
      (
        await form(
          '/auth/bootstrap/confirm',
          { confirm: 'yes' },
          proofCookie,
          'https://attacker.example.com',
        )
      ).status,
    ).toBe(403);
    const confirmations = await Promise.all([
      form('/auth/bootstrap/confirm', { confirm: 'yes' }, proofCookie),
      form('/auth/bootstrap/confirm', { confirm: 'yes' }, proofCookie),
    ]);
    expect(confirmations.map((response) => response.status).sort()).toEqual([302, 403]);
    const usersAfter = await env.db.select().from(users);
    expect(usersAfter).toHaveLength(1);
    expect(usersAfter[0]).toMatchObject({
      role: 'admin',
      provider: 'oidc:company',
      provider_id: 'administrator-subject',
      plan: 'custom',
    });
    expect((await env.db.select().from(platformLoginConnections))[0]).toMatchObject({
      enabled: true,
      active_revision: 1,
    });
    const adminCookie = confirmations
      .find((response) => response.status === 302)!
      .headers.getSetCookie()
      .find((cookie) => cookie.startsWith('admin_token='))!
      .split(';')[0]!;
    expect(
      (
        await app.fetch(
          new Request(`${origin}/admin/config/auth`, { headers: { Cookie: adminCookie } }),
          bindings(),
        )
      ).status,
    ).toBe(200);
    expect((await form('/auth/bootstrap/confirm', { confirm: 'yes' }, proofCookie)).status).toBe(
      403,
    );
    expect(
      (
        await initialize({
          bootstrapCredentialHash: await hashLoginProof(randomLoginProof()),
          resetPending: true,
        })
      ).status,
    ).toBe(409);
    expect(await (await initialize()).json()).toMatchObject({ setupPending: false });
  });

  it('allows an explicit installer-authorized reset only before an administrator exists', async () => {
    await initialize();
    await env.db
      .update(platformAuthBootstrap)
      .set({ expires_at: new Date(0).toISOString() })
      .where(eq(platformAuthBootstrap.singleton, true));
    expect((await form('/auth/bootstrap', { code })).status).toBe(403);
    expect((await app.fetch(new Request(`${origin}/setup`), bindings())).status).toBe(410);
    const oldCode = code;
    code = randomLoginProof();
    expect((await initialize()).status).toBe(409);
    expect((await initialize({ resetPending: true })).status).toBe(200);
    expect((await form('/auth/bootstrap', { code: oldCode })).status).toBe(403);
    expect((await form('/auth/bootstrap', { code })).status).toBe(302);
  });
});
