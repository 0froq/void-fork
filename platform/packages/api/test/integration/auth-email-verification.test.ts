import { and, eq } from 'drizzle-orm';
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
import {
  createOAuthAccount,
  getUserByOAuthAccount,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import { githubInstallations, invitations, oauthAccounts, users } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
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
  // github_installations isn't known to the shared clearTables helper; clear it
  // before it removes the users they reference (mirrors the routes test).
  await env.db.delete(githubInstallations);
  await clearTables(env.db);
  delete (env as TestEnv & { GITHUB_PREVIEW_REPO_PAT?: string }).GITHUB_PREVIEW_REPO_PAT;
  await env.ROUTING.delete('signup:enabled');
  await env.ROUTING.delete('signup:allowlist');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildSignedState(provider: string): Promise<string> {
  const redirect = 'http://localhost:9999/callback';
  const stateData = JSON.stringify({ redirect, nonce: 'test-nonce', provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, JWT_SECRET);
  return `${stateEncoded}.${signature}`;
}

function mockGitHubApi(ghUser: {
  id: number;
  login: string;
  email: string | null;
  emailVerified: boolean;
  publicEmail?: boolean;
}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'test-gh-token' });
    }

    if (url === 'https://api.github.com/user') {
      return Response.json({
        id: ghUser.id,
        login: ghUser.login,
        email: ghUser.publicEmail ? ghUser.email : null,
      });
    }

    if (url === 'https://api.github.com/user/emails') {
      if (ghUser.email) {
        return Response.json([
          { email: ghUser.email, primary: true, verified: ghUser.emailVerified },
        ]);
      }
      return Response.json([]);
    }

    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe('email verification gating on account linking', () => {
  it.each([true, false])(
    'uses the platform allowlist for restricted signup (allowed: %s)',
    async (allowed) => {
      // A stale legacy secret must neither bypass access control nor trigger repository API calls.
      Object.assign(env, { GITHUB_PREVIEW_REPO_PAT: 'test-legacy-pat' });
      await env.ROUTING.put('signup:enabled', 'true');
      await env.ROUTING.put(
        'signup:allowlist',
        JSON.stringify(allowed ? [{ type: 'github', pattern: 'invited-user' }] : []),
      );
      const fetchMock = mockGitHubApi({
        id: 44444,
        login: 'invited-user',
        email: 'invited@example.com',
        emailVerified: true,
      });
      const state = await buildSignedState('github');
      await seedOAuthNonce(env.db, 'test-nonce');
      vi.stubGlobal('fetch', fetchMock);
      const res = await app.fetch(
        new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
          headers: { Cookie: 'oauth_nonce=test-nonce' },
        }),
        env,
        executionCtx,
      );
      expect(res.status).toBe(302);
      if (allowed) {
        expect(res.headers.get('Location')).toContain('http://localhost:9999/callback?token=');
        expect(await getUserByOAuthAccount(env.db, 'github', '44444')).not.toBeNull();
      } else {
        expect(res.headers.get('Location')).toBe('/signup-restricted');
        expect(await getUserByOAuthAccount(env.db, 'github', '44444')).toBeNull();
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/repos/'))).toBe(false);
    },
  );

  it('does not link to existing account when GitHub email is unverified', async () => {
    const existing = await createTestUser(env.db, 'existing-user');
    await env.db
      .update(users)
      .set({ email: 'shared@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 99999,
        login: 'new-gh-user',
        email: 'shared@example.com',
        emailVerified: false,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).not.toBe(existing.id);
  });

  it('links to existing account when GitHub has public email that is verified', async () => {
    const existing = await createTestUser(env.db, 'public-email-user');
    await env.db
      .update(users)
      .set({ email: 'public@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 77777,
        login: 'public-email-gh-user',
        email: 'public@example.com',
        emailVerified: true,
        publicEmail: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it('links to existing account when GitHub email is verified (private email)', async () => {
    const existing = await createTestUser(env.db, 'linkable-user');
    await env.db
      .update(users)
      .set({ email: 'verified@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 88888,
        login: 'verified-gh-user',
        email: 'verified@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it('accepts a pending invitation when an existing account logs in with a verified email', async () => {
    const inviter = await createTestUser(env.db, 'inviter');
    const existing = await createTestUser(env.db, 'invited-existing', 'github', '424242');
    await env.db
      .update(users)
      .set({ email: 'invited-existing@example.com' })
      .where(eq(users.id, existing.id));
    await env.db.insert(invitations).values({
      id: 'inv_existing_login',
      email: 'invited-existing@example.com',
      invited_by: inviter.id,
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 424242,
        login: 'invited-existing',
        email: 'invited-existing@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const [invitation] = await env.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, 'inv_existing_login'));
    expect(invitation.status).toBe('accepted');
    expect(invitation.accepted_by).toBe(existing.id);
    expect(invitation.accepted_at).toBeTruthy();
  });

  it('does not grant source repository access after an unrestricted signup', async () => {
    Object.assign(env, { GITHUB_PREVIEW_REPO_PAT: 'test-legacy-pat' });
    const fetchMock = mockGitHubApi({
      id: 55555,
      login: 'new-user',
      email: 'new@example.com',
      emailVerified: true,
    });
    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/repos/'))).toBe(false);
  });

  it('does not link a SECOND github identity when the existing account already has one (RFC 0074 one-github invariant)', async () => {
    // Alice signed in via google, then linked github id X.
    const existing = await createTestUser(env.db, 'one-github-alice', 'google', 'google-alice');
    await env.db
      .update(users)
      .set({ email: 'one-github@example.com' })
      .where(eq(users.id, existing.id));
    await createOAuthAccount(env.db, existing.id, 'github', '111111'); // X

    // An UNOWNED installation whose account_id is the REJECTED github id Y.
    // Because Y is rejected as an identity, the backfill must NOT claim it.
    await upsertGitHubInstallation(env.db, {
      installationId: '600',
      userId: null,
      accountLogin: 'another-gh-account',
      accountId: '222222', // Y
      accountType: 'User',
      repositories: [{ full_name: 'another-gh-account/app', id: 1 }],
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    // Now log in with a DIFFERENT github id Y whose verified email matches Alice.
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 222222, // Y != X
        login: 'another-gh-account',
        email: 'one-github@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    // Signed into the EXISTING account (not a new user)...
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);

    // ...and NO github row for Y was created (still exactly one github row, X).
    const githubRows = await env.db
      .select({ providerId: oauthAccounts.provider_id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.user_id, existing.id), eq(oauthAccounts.provider, 'github')));
    expect(githubRows.length).toBe(1);
    expect(githubRows[0]!.providerId).toBe('111111');
    expect(await getUserByOAuthAccount(env.db, 'github', '222222')).toBeNull();

    // ...and the unowned installation for the REJECTED id Y was NOT claimed.
    const [install] = await env.db
      .select({ userId: githubInstallations.user_id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installation_id, '600'));
    expect(install?.userId).toBeNull();
  });

  it('consolidates a github login onto an existing account that has NO github yet (cross-provider link unchanged)', async () => {
    // Bob signed in via google, has NO github identity.
    const existing = await createTestUser(env.db, 'no-github-bob', 'google', 'google-bob');
    await env.db
      .update(users)
      .set({ email: 'no-github@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 333333,
        login: 'bob-gh',
        email: 'no-github@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    // Signed into the existing account...
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);

    // ...and the github row WAS created and is owned by the existing account.
    const owner = await getUserByOAuthAccount(env.db, 'github', '333333');
    expect(owner?.id).toBe(existing.id);
  });
});
