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
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import { signJwt } from '../../src/auth/jwt.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import { createHumanSession } from '../../src/auth/sessions.ts';
import { app } from '../../src/index.ts';
import { platformAuthSettings } from '../../src/schema.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let key: CryptoKey;
let jwk: Record<string, unknown>;
let user: Awaited<ReturnType<typeof createTestUser>>;
let humanToken: string;
const origin = 'https://api.example.com';
const proxy = 'https://proxy.example.com';
const issuer = 'https://company.cloudflareaccess.com';
const companyIdentity = { issuer, subject: 'employee-1' };
beforeAll(async () => {
  env = await setupEnv();
  const pair = await generateKeyPair('RS256', { extractable: true });
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'company-key', use: 'sig' };
});
afterAll(teardownEnv);
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await clearTables(env.db);
  user = await createTestUser(env.db, 'existing-user', 'github', '123', 'custom', 'admin');
  await importLegacyAuthentication(env.db, env);
  await env.db.update(platformAuthSettings).set({
    protection: {
      teamDomain: issuer,
      applications: [
        { origin, audience: 'api-aud' },
        { origin: proxy, audience: 'proxy-aud' },
      ],
    },
    admission: { mode: 'company', access: true, connections: [] },
  });
  humanToken = (
    await createHumanSession(env.db, env.JWT_SECRET, {
      userId: user.id,
      connectionId: 'github',
      revision: 1,
      generation: 1,
      audience: 'api',
      companyIdentity,
    })
  ).token;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === `${issuer}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [jwk] });
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-fixture' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 456,
          login: 'new-employee',
          email: 'personal@elsewhere.example',
        });
      }
      if (url === 'https://api.github.com/user/emails') {
        return Response.json([
          { email: 'personal@elsewhere.example', primary: true, verified: true },
        ]);
      }
      throw new Error('Unexpected outbound request');
    }),
  );
});

function assertion(options: { service?: boolean; audience?: string; subject?: string } = {}) {
  return new SignJWT({
    type: 'app',
    ...(options.service ? { common_name: 'ci.access' } : { email: 'employee@company.example' }),
  })
    .setIssuer(issuer)
    .setAudience(options.audience ?? 'api-aud')
    .setSubject(options.service ? '' : (options.subject ?? 'employee-1'))
    .setIssuedAt()
    .setExpirationTime('5m')
    .setProtectedHeader({ alg: 'RS256', kid: 'company-key' })
    .sign(key);
}
function request(
  path: string,
  access?: string,
  token?: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(access ? { 'Cf-Access-Jwt-Assertion': access } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, PROXY_URL: proxy, PLATFORM_HEALTH_PROBE_TOKEN: 'probe-fixture' },
  );
}

describe('Access-protected platform requests', () => {
  it('keeps existing signup controls authoritative after authentication migration without removing the gate', async () => {
    const access = await assertion();
    const elevation = await request('/operator/v1/session', access, humanToken, {});
    const operator = (await elevation.json<{ token: string }>()).token;
    expect((await request('/operator/v1/signup/restrict', access, operator, {})).status).toBe(200);
    expect((await env.db.select().from(platformAuthSettings))[0]?.admission).toEqual({
      mode: 'restricted',
    });
    expect((await request('/operator/v1/signup/open', access, operator, {})).status).toBe(200);
    const settings = (await env.db.select().from(platformAuthSettings))[0]!;
    expect(settings.admission).toEqual({ mode: 'public' });
    expect(settings.protection?.teamDomain).toBe(issuer);
    expect((await request('/auth/login')).status).toBe(403);
  });
  it('requires both the company identity and the matching Void session', async () => {
    expect((await request('/me', undefined, humanToken)).status).toBe(403);
    expect((await request('/me', await assertion())).status).toBe(401);
    expect((await request('/me', await assertion(), humanToken)).status).toBe(200);
    expect(
      (await request('/me', await assertion({ subject: 'employee-2' }), humanToken)).status,
    ).toBe(401);
    expect((await request('/me', await assertion({ service: true }), humanToken)).status).toBe(403);
  });

  it('does not let installer probes or alternate origins bypass company protection', async () => {
    expect(
      (
        await request('/health', undefined, undefined, undefined, {
          'X-Void-Platform-Probe': 'probe-fixture',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          new Request('https://alternate.workers.dev/me', {
            headers: {
              Authorization: `Bearer ${humanToken}`,
              'Cf-Access-Jwt-Assertion': await assertion(),
            },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect((await request('/internal/unrecognized')).status).toBe(403);
  });

  it('allows narrow machine operations only with the separate Void authority', async () => {
    const access = await assertion({ service: true });
    expect((await request('/health', access)).status).toBe(403);
    expect(
      (
        await request('/health', access, undefined, undefined, {
          'X-Void-Platform-Probe': 'probe-fixture',
        })
      ).status,
    ).toBe(200);
    expect((await request('/.well-known/void-platform', access)).status).toBe(200);
    expect((await request('/admin/login', access)).status).toBe(403);
    expect((await request('/auth/login', access)).status).toBe(403);
    expect((await request('/projects', access)).status).toBe(403);
    const project = await createTestProject(env.db, user.id, 'ci-project');
    const deploy = await signJwt(
      { sub: user.id, login: user.login, aud: 'deploy', project: project.id },
      env.JWT_SECRET,
    );
    expect((await request('/projects', access, deploy)).status).toBe(200);
    expect((await request(`/projects/${project.id}/delete`, access, deploy, {})).status).toBe(403);
  });

  it('creates an account automatically after Access approval and independent GitHub login', async () => {
    const access = await assertion({ subject: 'new-employee' });
    const verifier = 'b'.repeat(64);
    const params = new URLSearchParams({
      provider: 'github',
      redirect: 'http://localhost:3456/callback?state=cli',
      code_challenge: await createCodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const start = await request(`/auth/login?${params}`, access);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('Location')!).searchParams.get('state');
    const cookie = start.headers.get('Set-Cookie')!.split(';')[0]!;
    const callback = await request(
      `/auth/callback?code=github-code&state=${state}`,
      access,
      undefined,
      undefined,
      { Cookie: cookie },
    );
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.get('Location')!).searchParams.get('code');
    const exchange = await request('/auth/cli/token', access, undefined, {
      code,
      state: 'cli',
      code_verifier: verifier,
    });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json<{ token: string }>()).token;
    const me = await request('/me', access, token);
    expect(me.status).toBe(200);
    const identity = await me.json<Record<string, unknown>>();
    expect(JSON.stringify(identity)).toContain('new-employee');
    expect((await request('/operator/v1/session', access, token, {})).status).toBe(403);
  });

  it('verifies the proxy audience and company subject in the internal ownership authority', async () => {
    const project = await createTestProject(env.db, user.id, 'proxy-project');
    const internal = await hmacSignState(project.id, env.JWT_SECRET);
    const check = (accessAssertion: string) =>
      request(
        `/internal/verify-owner/${project.id}`,
        undefined,
        undefined,
        { userId: user.id, jwt: humanToken, accessAssertion },
        { 'X-Void-Internal': internal },
      );
    expect((await check(await assertion({ audience: 'proxy-aud' }))).status).toBe(200);
    expect((await check(await assertion())).status).toBe(403);
    expect(
      (await check(await assertion({ audience: 'proxy-aud', subject: 'employee-2' }))).status,
    ).toBe(403);
    expect(
      (
        await request(`/internal/verify-owner/${project.id}`, undefined, undefined, {
          userId: user.id,
        })
      ).status,
    ).toBe(401);
  });
});
