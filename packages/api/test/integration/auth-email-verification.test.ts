import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { hmacSignState } from '../../src/auth/hmac';
import app from '../../src/index';
import { users } from '../../src/schema';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createMockExecutionContext,
  seedOAuthNonce,
  JWT_SECRET,
  type TestEnv,
} from './helpers';

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
  delete env.GITHUB_PREVIEW_REPO_PAT;
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
  previewRepo?: {
    owner: string;
    repo: string;
    collaboratorStatus?: number;
    pendingInvite?: boolean;
  };
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

    if (ghUser.previewRepo) {
      const repoBase = `https://api.github.com/repos/${ghUser.previewRepo.owner}/${ghUser.previewRepo.repo}`;
      const collaboratorUrl = `${repoBase}/collaborators/${ghUser.login}`;

      if (url === collaboratorUrl) {
        if (_init?.method === 'PUT') {
          return new Response(null, { status: 201 });
        }

        return new Response(null, { status: ghUser.previewRepo.collaboratorStatus ?? 404 });
      }

      if (url === `${repoBase}/invitations`) {
        return Response.json(
          ghUser.previewRepo.pendingInvite ? [{ id: 1, invitee: { login: ghUser.login } }] : [],
        );
      }
    }

    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe('email verification gating on account linking', () => {
  it('allows new GitHub signup when signup is restricted but the user already has preview repo access', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';
    await env.ROUTING.put('signup:enabled', 'true');

    const fetchMock = mockGitHubApi({
      id: 44444,
      login: 'repo-collaborator',
      email: 'repo-collaborator@example.com',
      emailVerified: true,
      previewRepo: {
        owner: 'void-sdk',
        repo: 'void',
        collaboratorStatus: 204,
      },
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
    expect(res.headers.get('Location')).toContain('http://localhost:9999/callback?token=');
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/repo-collaborator',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('rejects new GitHub signup when signup is restricted and the user lacks preview repo access', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';
    await env.ROUTING.put('signup:enabled', 'true');

    const fetchMock = mockGitHubApi({
      id: 33333,
      login: 'not-a-collaborator',
      email: 'not-a-collaborator@example.com',
      emailVerified: true,
      previewRepo: {
        owner: 'void-sdk',
        repo: 'void',
        collaboratorStatus: 404,
      },
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
    expect(res.headers.get('Location')).toBe('/signup-restricted');
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/not-a-collaborator',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

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

    const { verifyJwt } = await import('../../src/auth/jwt');
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

    const { verifyJwt } = await import('../../src/auth/jwt');
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

    const { verifyJwt } = await import('../../src/auth/jwt');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it('invites the GitHub user to the preview repo when configured', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';

    const fetchMock = mockGitHubApi({
      id: 55555,
      login: 'preview-gh-user',
      email: 'preview@example.com',
      emailVerified: true,
      previewRepo: { owner: 'void-sdk', repo: 'void' },
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
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/preview-gh-user',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('does not create a duplicate preview repo invitation when one is already pending', async () => {
    env.GITHUB_PREVIEW_REPO_PAT = 'test-preview-pat';

    const fetchMock = mockGitHubApi({
      id: 66666,
      login: 'pending-preview-gh-user',
      email: 'pending-preview@example.com',
      emailVerified: true,
      previewRepo: {
        owner: 'void-sdk',
        repo: 'void',
        pendingInvite: true,
      },
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
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.github.com/repos/void-sdk/void/collaborators/pending-preview-gh-user',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});
