import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
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
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import type { Db } from '../../src/db.ts';
import {
  createBuild,
  getBuild,
  getGitHubConnection,
  getGitHubInstallation,
  getProjectBuilds,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { authMiddleware } from '../../src/middleware/auth.ts';
import { githubProjectRoutes, githubRoutes } from '../../src/routes/github.ts';
import { builds, githubConnections, githubInstallations } from '../../src/schema.ts';
import {
  JWT_SECRET,
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// The callback mints an installation token (which would otherwise require a
// real RS256 PKCS#8 key via createAppJwt). Stub it so the test only exercises
// the route's ownership logic; the repo list is served by the mocked fetch.
// `getInstallationAccount` (App-JWT account lookup for empty-repos installs) is
// stubbed to skip createAppJwt while still hitting the test's stubbed global
// fetch for `GET /app/installations/:id`, so the route's real fail-open/closed
// branching is exercised against a mocked GitHub response.
vi.mock('../../src/github/installation-token.ts', () => ({
  getInstallationToken: async () => 'test-installation-token',
  getInstallationAccount: async (_env: unknown, installationId: string) => {
    const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      account?: { id?: number | string; login?: string; type?: string };
    };
    const account = data.account;
    if (!account || (typeof account.id !== 'number' && typeof account.id !== 'string')) {
      return null;
    }
    if (typeof account.login !== 'string' || account.login === '') {
      return null;
    }
    return {
      accountId: String(account.id),
      login: account.login,
      type: account.type === 'Organization' ? 'Organization' : 'User',
    };
  },
}));

let env: TestEnv;

// Self-contained app that mirrors how index.ts mounts the github routers:
//   - /github            -> githubRoutes (auth applied per-route inside)
//   - /projects/* (auth) -> githubProjectRoutes (ownership check inside)
// Mounting here keeps the test independent of the parent integrator's wiring.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes)
  .use('/projects/*', authMiddleware)
  .route('/projects', githubProjectRoutes);

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

// github_* tables aren't known to the shared clearTables helper; clear them
// (in FK-safe order) before it removes the projects/users they reference.
async function clearGitHubTables(db: Db): Promise<void> {
  await db.delete(builds);
  await db.delete(githubConnections);
  await db.delete(githubInstallations);
}

beforeEach(async () => {
  await clearGitHubTables(env.db);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authed(jwt: string, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

// A BUILD_MANAGER stand-in that records which build ids (keyed by the DO name,
// which the handler sets to the build id) received a `cancelBuild` RPC. The
// handler tears down orphaned containers via the trusted `cancelBuild` RPC on
// BuildManager; the call is best-effort, so here we only assert it was ATTEMPTED
// for the right (active container) builds. A `fetch` shim is kept for any
// agent-authenticated `POST /cancel` path so the mock degrades gracefully.
function recordingBuildManager(): {
  namespace: DurableObjectNamespace;
  cancelledIds: ReadonlyArray<string>;
} {
  const cancelledIds: Array<string> = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      cancelBuild: async (_reason?: string) => {
        cancelledIds.push(id.toString());
      },
      fetch: async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/cancel') {
          cancelledIds.push(id.toString());
        }
        return Response.json({ ok: true });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, cancelledIds };
}

// Minimal GitHub App env so isGitHubAppConfigured() is true. The private key is
// never parsed because getInstallationToken is mocked above.
const GITHUB_APP_ENV = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: 'unused-because-token-is-mocked',
} as const;

// The App's user-to-server OAuth credentials. Present only when the App is
// configured for "Request user authorization (OAuth) during installation" — the
// callback's org-install path is inert without these.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

// Build a valid signed state exactly the way GET /install-url mints it.
async function mintInstallState(userId: string, githubAccountId: string): Promise<string> {
  const encoded = btoa(JSON.stringify({ userId, githubAccountId, nonce: crypto.randomUUID() }));
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Stub global fetch so the callback's `GET /installation/repositories` returns
// the given repos/owner. Anything else throws so an unexpected call is loud.
function mockInstallationRepos(owner: { login: string; id: number; type: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        return Response.json({
          repositories: [{ full_name: `${owner.login}/app`, id: 1, owner }],
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
}

// Stub global fetch for the user-authorization-on-install path. Serves:
//   - `GET /installation/repositories` (repo list + owner; here an org)
//   - `POST login/oauth/access_token` (install code -> user token), unless the
//     code is rejected (`acceptCode === false`, mimicking a bad/expired code)
//   - `GET /user` (the code-holder's own numeric account id — bound against the
//     signed state to prove the code-holder IS the install initiator)
//   - `GET /user/installations` (the installations the user can manage)
// Captures the token-exchange `code` so a test can assert it was attempted.
function mockUserAuthInstall(opts: {
  owner: { login: string; id: number; type: string };
  // Installation ids returned by GET /user/installations for the user token.
  userInstallationIds: ReadonlyArray<number>;
  // The numeric account id returned by GET /user for the code-holder. Defaults
  // to the owner id so the legitimate-initiator case needs no extra wiring.
  callerAccountId?: number;
  // When false, the token exchange returns a GitHub `{ error }` body.
  acceptCode?: boolean;
}): { calls: { tokenExchange: boolean; userInstallations: boolean; user: boolean } } {
  const calls = { tokenExchange: false, userInstallations: false, user: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        return Response.json({
          repositories: [{ full_name: `${opts.owner.login}/app`, id: 1, owner: opts.owner }],
        });
      }
      if (url.includes('login/oauth/access_token')) {
        calls.tokenExchange = true;
        if (opts.acceptCode === false) {
          return Response.json({ error: 'bad_verification_code' });
        }
        return Response.json({ access_token: 'user-to-server-token' });
      }
      if (url.includes('/user/installations')) {
        calls.userInstallations = true;
        return Response.json({
          installations: opts.userInstallationIds.map((id) => ({ id })),
        });
      }
      // The bare `GET /user` endpoint — checked AFTER `/user/installations` so
      // the more specific path wins.
      if (url.endsWith('/user')) {
        calls.user = true;
        return Response.json({ id: opts.callerAccountId ?? opts.owner.id });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
  return { calls };
}

// Stub global fetch for an EMPTY-repos installation callback. `GET
// /installation/repositories` returns no repos (so the owner can't be derived
// from a repo), forcing the callback onto the authoritative App-JWT account
// lookup `GET /app/installations/:id`. When `account` is null, that endpoint
// fails (500) so the callback must fail closed (502).
function mockEmptyInstallAccount(opts: {
  account: { login: string; id: number; type: string } | null;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        // No repositories → owner is undefined → derive returns null.
        return Response.json({ repositories: [] });
      }
      // The App-JWT account lookup: `GET /app/installations/:id` (must NOT match
      // the `/access_tokens` sub-path; that's the token mint, which is mocked).
      if (/\/app\/installations\/[^/]+$/.test(new URL(url).pathname)) {
        if (opts.account === null) {
          return new Response('boom', { status: 500 });
        }
        return Response.json({ account: opts.account });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
}

describe('POST /projects/:id/github', () => {
  it('connects a project to a repo within the caller installation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-app');
    await upsertGitHubInstallation(env.db, {
      installationId: '111',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '111',
          repoFullName: 'acme/app',
          branch: 'release',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as {
      project_id: string;
      installation_id: string;
      repo_full_name: string;
      branch: string;
      build_executor: string;
    };
    expect(connection.project_id).toBe(project.id);
    expect(connection.installation_id).toBe('111');
    expect(connection.repo_full_name).toBe('acme/app');
    expect(connection.branch).toBe('release');
    expect(connection.build_executor).toBe('github_actions');

    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repo_full_name).toBe('acme/app');
  });

  // the connect handler must capture the repo's IMMUTABLE numeric id from
  // the installation's cached repository list so webhook/OIDC routing keys on it
  // (full_name is mutable). Without it, a rename/name-reuse could misroute a
  // deploy.
  it('captures the immutable repository_id at connect time', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-repo-id');
    await upsertGitHubInstallation(env.db, {
      installationId: '112',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 4242 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '112', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('4242');
  });

  // an empty branch must be rejected at the POST guard. createGitHubConnection
  // uses `args.branch ?? 'main'`, and `??` does NOT catch '', so an empty string
  // would be stored verbatim and no push/OIDC ref could ever match it → a silent
  // dead connection. PATCH already rejects '' the same way.
  it('returns 400 when the branch is an empty string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-empty-branch');
    await upsertGitHubInstallation(env.db, {
      installationId: '113',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '113', repoFullName: 'acme/app', branch: '' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid branch');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('persists a custom workflow_path (.yaml accepted)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-custom');
    await upsertGitHubInstallation(env.db, {
      installationId: '211',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '211',
          repoFullName: 'acme/app',
          workflowPath: '.github/workflows/deploy.yaml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { workflow_path: string };
    expect(connection.workflow_path).toBe('.github/workflows/deploy.yaml');
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/deploy.yaml');
  });

  it('defaults workflow_path to the scaffolded void-deploy.yml when omitted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-default');
    await upsertGitHubInstallation(env.db, {
      installationId: '212',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '212', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/void-deploy.yml');
  });

  it('returns 400 when workflowPath is outside .github/workflows/', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-badprefix');
    await upsertGitHubInstallation(env.db, {
      installationId: '213',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // No `.github/workflows/` prefix — GitHub could never run it, so it could
        // never match a real OIDC workflow_ref.
        body: JSON.stringify({
          installationId: '213',
          repoFullName: 'acme/app',
          workflowPath: 'ci.yml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 400 when workflowPath contains a .. traversal', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-traversal');
    await upsertGitHubInstallation(env.db, {
      installationId: '214',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '214',
          repoFullName: 'acme/app',
          workflowPath: '.github/workflows/../../evil.yml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // connecting against a suspended/deleted installation must be rejected.
  // getGitHubInstallation returns suspended/deleted rows, and a `selected` install
  // keeps its cached repos, so the connect would otherwise succeed — but every
  // build resolver requires status='active', so the connection would never build.
  it('returns 409 when the installation is not active', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-suspended');
    await upsertGitHubInstallation(env.db, {
      installationId: '114',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, '114'));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '114', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('installation is not active');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('defaults branch to main and executor to container', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-defaults');
    await upsertGitHubInstallation(env.db, {
      installationId: '111',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '111', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { branch: string; build_executor: string };
    expect(connection.branch).toBe('main');
    expect(connection.build_executor).toBe('container');
  });

  it('returns 403 when the project belongs to another user', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-403');
    await upsertGitHubInstallation(env.db, {
      installationId: '222',
      userId: other.id,
      accountLogin: 'other',
      accountId: 'acc_2',
      accountType: 'User',
      repositories: [{ full_name: 'other/app', id: 9 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${other.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '222', repoFullName: 'other/app' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('rejects an installation that does not belong to the caller', async () => {
    const user = await createTestUser(env.db, 'caller');
    const stranger = await createTestUser(env.db, 'stranger');
    const project = await createTestProject(env.db, user.id, 'gh-foreign-install');
    // Installation linked to a different user.
    await upsertGitHubInstallation(env.db, {
      installationId: '333',
      userId: stranger.id,
      accountLogin: 'stranger',
      accountId: 'acc_3',
      accountType: 'User',
      repositories: [{ full_name: 'stranger/app', id: 7 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '333', repoFullName: 'stranger/app' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('rejects a repo not accessible by the installation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-no-repo');
    await upsertGitHubInstallation(env.db, {
      installationId: '444',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_4',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '444', repoFullName: 'acme/not-granted' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // An `all`-repos install covers every repo in the account, including ones not
  // in the cached `repositories` array (e.g. created after install). The connect
  // route must skip array membership and resolve the id LIVE via GET /repos.
  it('connects a repo absent from the cache under an all-repos install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-all');
    await upsertGitHubInstallation(env.db, {
      installationId: '888',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_8',
      accountType: 'Organization',
      // Cache lists a DIFFERENT repo; the target is not in it.
      repositories: [{ full_name: 'acme/old', id: 1 }],
      repositorySelection: 'all',
    });

    // The route resolves the id via GET /repos/:full_name for `all` installs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/acme/new')) {
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '888', repoFullName: 'acme/new' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repo_full_name).toBe('acme/new');
    // The id must come from the LIVE lookup, not the (stale) cache.
    expect(persisted?.repository_id).toBe('9999');
  });

  // Fail-closed: even under an `all` install, a repo the installation can't
  // actually see (GET /repos 404s) is rejected rather than connected blindly.
  it('rejects a repo whose live lookup 404s under an all-repos install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-all-404');
    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_9',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/acme/missing')) {
          return new Response('Not Found', { status: 404 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '999', repoFullName: 'acme/missing' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // The `selected` path keys off the cached array and never hits the network.
  // An unmocked fetch here would throw, so reaching 200 also proves no live
  // lookup happens for `selected` installs.
  it('uses the cached array (no live lookup) for a selected install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-selected');
    await upsertGitHubInstallation(env.db, {
      installationId: '1010',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_10',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 5151 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '1010', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('5151');
  });

  it('returns 409 when the project is already connected', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-dup');
    await upsertGitHubInstallation(env.db, {
      installationId: '555',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_5',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const body = { installationId: '555', repoFullName: 'acme/app' };
    const first = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(second.status).toBe(409);
  });
});

describe('GET /projects/:id/github', () => {
  it('returns the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-get');
    await upsertGitHubInstallation(env.db, {
      installationId: '666',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_6',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '666', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const connection = (await res.json()) as { repo_full_name: string };
    expect(connection.repo_full_name).toBe('acme/app');
  });

  it('returns 404 when there is no connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-get-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for a project owned by someone else', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-get-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(other.jwt)),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /projects/:id/github', () => {
  it('updates branch and build executor', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch');
    await upsertGitHubInstallation(env.db, {
      installationId: '777',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '777', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop', buildExecutor: 'github_actions' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const updated = (await res.json()) as { branch: string; build_executor: string };
    expect(updated.branch).toBe('develop');
    expect(updated.build_executor).toBe('github_actions');
  });

  it('updates workflow_path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-wf');
    await upsertGitHubInstallation(env.db, {
      installationId: '778',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '778', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: '.github/workflows/ci.yml' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { workflow_path: string }).workflow_path).toBe(
      '.github/workflows/ci.yml',
    );
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/ci.yml');
  });

  it('returns 400 when workflowPath is invalid on PATCH', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-wf-bad');
    await upsertGitHubInstallation(env.db, {
      installationId: '779',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '779', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: 'not-under-workflows.yml' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    // The connection's workflow_path is unchanged (still the default).
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/void-deploy.yml');
  });

  it('returns 404 when there is no connection to patch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  // A branch change orphans in-flight builds for the OLD branch — their deploy
  // tokens must be revoked. Builds on a DIFFERENT branch keep running.
  it('cancels OLD-branch in-flight builds on a branch change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-branch');
    await upsertGitHubInstallation(env.db, {
      installationId: '780',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_b',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Connection starts on `main`.
        body: JSON.stringify({ installationId: '780', repoFullName: 'acme/app', branch: 'main' }),
      }),
      env,
    );

    const mainBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });
    const developBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'develop',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: string }).branch).toBe('develop');

    // The OLD-branch (main) build is cancelled; the develop build is untouched.
    expect((await getBuild(env.db, mainBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, mainBuild.id))!.error).toBe('branch changed');
    expect((await getBuild(env.db, developBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([mainBuild.id]);
  });

  // An executor change orphans in-flight builds for the OLD executor.
  it('cancels OLD-executor in-flight builds on an executor change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-exec');
    await upsertGitHubInstallation(env.db, {
      installationId: '781',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_e',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Connection starts on the `container` executor.
        body: JSON.stringify({
          installationId: '781',
          repoFullName: 'acme/app',
          buildExecutor: 'container',
        }),
      }),
      env,
    );

    const containerBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const actionsBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildExecutor: 'github_actions' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // The OLD-executor (container) build is cancelled; the actions build is untouched.
    expect((await getBuild(env.db, containerBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, containerBuild.id))!.error).toBe('executor changed');
    expect((await getBuild(env.db, actionsBuild.id))!.status).toBe('building');
    // DO cancel attempted for the cancelled CONTAINER build.
    expect(cancelledIds).toEqual([containerBuild.id]);
  });

  // A workflow_path change is a trust-boundary change: it must orphan in-flight
  // github_actions builds authorized under the OLD pin (their deploy token stays
  // valid while the build is active), the SAME way branch/executor changes do.
  // Container builds don't use the workflow gate, so they keep running.
  it('cancels in-flight github_actions builds on a workflow_path change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-workflow');
    await upsertGitHubInstallation(env.db, {
      installationId: '783',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_w',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // github_actions executor, default workflow (.github/workflows/void-deploy.yml).
        body: JSON.stringify({
          installationId: '783',
          repoFullName: 'acme/app',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    const actionsBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const containerBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: '.github/workflows/ci.yml' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workflow_path: string }).workflow_path).toBe(
      '.github/workflows/ci.yml',
    );

    // The github_actions build (authorized under the OLD pin) is cancelled; the
    // container build is untouched (it never used the workflow gate).
    expect((await getBuild(env.db, actionsBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, actionsBuild.id))!.error).toBe('workflow path changed');
    expect((await getBuild(env.db, containerBuild.id))!.status).toBe('building');
    // github_actions builds have no container DO, so no DO cancel is attempted.
    expect(cancelledIds).toEqual([]);
  });

  // A no-op PATCH (values unchanged) must terminalize NOTHING.
  it('cancels no builds on a no-op PATCH', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-noop');
    await upsertGitHubInstallation(env.db, {
      installationId: '782',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_n',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '782',
          repoFullName: 'acme/app',
          branch: 'main',
          buildExecutor: 'container',
        }),
      }),
      env,
    );

    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Same branch + executor the connection already has.
        body: JSON.stringify({ branch: 'main', buildExecutor: 'container' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // Nothing terminalized, no DO cancel attempted.
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toHaveLength(0);
  });

  // The terminate decision is computed from the connection row read UNDER the
  // FOR UPDATE lock (`current`), not a pre-tx snapshot. To prove it, drive the
  // PATCH's locked `current.branch` to differ from what the connection looked
  // like earlier: connect on `main`, then re-point the branch to `release`
  // directly in the DB (modeling a concurrent PATCH that committed first). A
  // PATCH `release` -> `develop` must terminate the `release` build (the locked
  // current branch) and leave a stray `main` build untouched — if it keyed off a
  // stale `main` snapshot it would cancel the wrong build.
  it('terminates builds for the LOCKED current branch, not a stale snapshot', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-locked');
    await upsertGitHubInstallation(env.db, {
      installationId: '783',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_l',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Connection starts on `main`.
        body: JSON.stringify({ installationId: '783', repoFullName: 'acme/app', branch: 'main' }),
      }),
      env,
    );

    // Re-point the connection to `release` out-of-band (models another PATCH that
    // committed first). The handler's pre-tx 404 guard read still sees the row;
    // its locked re-read inside the tx sees `release`.
    await env.db
      .update(githubConnections)
      .set({ branch: 'release' })
      .where(eq(githubConnections.project_id, project.id));

    // A stray build on the OLD branch (`main`) that must NOT be terminated, and a
    // build on the CURRENT locked branch (`release`) that MUST be terminated.
    const mainBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });
    const releaseBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'release',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: string }).branch).toBe('develop');

    // Terminated the LOCKED-current branch (`release`); the stale `main` build is
    // untouched — termination keyed off `current.branch`, not the snapshot.
    expect((await getBuild(env.db, releaseBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, releaseBuild.id))!.error).toBe('branch changed');
    expect((await getBuild(env.db, mainBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([releaseBuild.id]);
  });
});

describe('DELETE /projects/:id/github', () => {
  it('removes the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete');
    await upsertGitHubInstallation(env.db, {
      installationId: '888',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_8',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '888', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 when deleting a connection on another user project', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-delete-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  // Disconnecting must terminalize ALL in-flight builds (queued +
  // active, both executors). A still-running container build already minted a
  // VOID_TOKEN, and its build row staying active would keep the middleware
  // guard passing, so the container could keep publishing from a now-disconnected
  // repo. Terminalizing the row (→ cancelled) revokes the token; the DO `/cancel`
  // is a best-effort container teardown on top. github_actions builds are also
  // terminalized so they stop pinning a concurrency slot.
  it('terminalizes ALL in-flight builds (container + github_actions) on disconnect', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete-terminate');
    await upsertGitHubInstallation(env.db, {
      installationId: '889',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_9',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '889',
          repoFullName: 'acme/app',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    const actionsBuild = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '1000',
    });
    const activeContainer = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const queuedContainer = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
    });
    const deployingContainer = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'deploying',
    });
    // Terminal — left untouched, never sent to the DO.
    const completeContainer = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // Every in-flight build (both executors) is cancelled + stamped.
    for (const id of [
      actionsBuild.id,
      activeContainer.id,
      queuedContainer.id,
      deployingContainer.id,
    ]) {
      const row = await getBuild(env.db, id);
      expect(row!.status).toBe('cancelled');
      expect(row!.completed_at).not.toBeNull();
    }
    // The terminal build is left alone.
    expect((await getBuild(env.db, completeContainer.id))!.status).toBe('complete');

    // Sanity: exactly the four in-flight rows were terminalized.
    const all = await getProjectBuilds(env.db, project.id);
    expect(all.filter((b) => b.status === 'cancelled').length).toBe(4);

    // The DO `/cancel` was attempted for the cancelled CONTAINER builds only —
    // never the github_actions build, never the already-terminal build.
    expect([...cancelledIds].sort()).toEqual(
      [activeContainer.id, queuedContainer.id, deployingContainer.id].sort(),
    );

    // Terminate + delete run in one tx (locked on the connection row); the
    // connection is gone.
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // End-to-end: after disconnect cancels a build, a deploy token bound to
  // that build must be rejected by the central middleware guard. This proves the
  // status flip actually revokes the token — not just that the row is terminal.
  it('rejects a deploy token bound to a build that disconnect cancelled', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete-token');
    await upsertGitHubInstallation(env.db, {
      installationId: '890',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_10',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '890', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const build = await createBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const deployToken = await signDeployToken(
      { projectId: project.id, userId: user.id, login: user.login, buildId: build.id },
      JWT_SECRET,
    );

    // A deploy-token endpoint guarded by the same authMiddleware. Before
    // disconnect the build is active, so the guard lets the token through (the
    // stub handler returns 200).
    const guardApp = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', env.db);
        await next();
      })
      .use('/projects/*', authMiddleware)
      .post('/projects/:id/database', (context) => context.json({ ok: true }));

    const before = await guardApp.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deployToken}` },
      }),
      env,
    );
    expect(before.status).toBe(200);

    // Disconnect cancels the build.
    const del = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(del.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');

    // Now the same token is rejected by the guard (build no longer active).
    const after = await guardApp.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deployToken}` },
      }),
      env,
    );
    expect(after.status).toBe(403);
  });
});

describe('GET /github/installations', () => {
  it('lists the caller installations only', async () => {
    const user = await createTestUser(env.db, 'lister');
    const other = await createTestUser(env.db, 'other-lister');
    await upsertGitHubInstallation(env.db, {
      installationId: '901',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_901',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await upsertGitHubInstallation(env.db, {
      installationId: '902',
      userId: other.id,
      accountLogin: 'other',
      accountId: 'acc_902',
      accountType: 'User',
      repositories: [],
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(1);
    expect(installations[0]!.installation_id).toBe('901');
  });

  it('requires auth', async () => {
    const res = await app.fetch(new Request('http://localhost/github/installations'), env);
    expect(res.status).toBe(401);
  });
});

describe('GET /github/install-url', () => {
  it('returns 503 when the GitHub App slug is unset', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(503);
  });

  it('returns a signed install url when the slug is configured', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      { ...env, GITHUB_APP_SLUG: 'void-deploy' },
    );
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://github.com/apps/void-deploy/installations/new?state=')).toBe(
      true,
    );
  });

  it('returns 403 github_identity_required when the caller has no github identity', async () => {
    // A user authed via a non-github provider has no linked github oauth row,
    // so getCallerGitHubAccountId resolves null and the gate must reject.
    const user = await createTestUser(env.db, 'nogithub', 'google');
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      { ...env, GITHUB_APP_SLUG: 'void-deploy' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'github_identity_required' });
  });
});

describe('GET /github/callback', () => {
  it('returns 503 when the GitHub App is unconfigured', async () => {
    const res = await app.fetch(
      new Request('http://localhost/github/callback?installation_id=1&state=x.y'),
      env,
    );
    expect(res.status).toBe(503);
  });

  // Regression: a Void user (A) must not be able to claim — and re-own — an
  // installation that already belongs to another user (B) just by holding a
  // validly-signed state. Here the installation's GitHub account id is forced
  // to equal A's bound account id (a derivation gap / id collision), so the
  // primary account check passes — the owner-guard backstop is what must reject
  // the re-own and leave B's ownership intact.
  it('does not re-own another user installation (owner-guard backstop)', async () => {
    const userB = await createTestUser(env.db, 'victim', 'github', '5555');
    const userA = await createTestUser(env.db, 'attacker', 'github', '4242');

    // B already owns installation 999.
    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: userB.id,
      accountLogin: 'victim',
      accountId: '5555',
      accountType: 'User',
      repositories: [{ full_name: 'victim/app', id: 1 }],
    });

    // The installation's repos resolve to an account id (4242) that happens to
    // equal A's bound github account id, so the primary check would pass.
    mockInstallationRepos({ login: 'victim', id: 4242, type: 'User' });

    // A holds a valid state bound to A's own github account id (4242).
    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=999&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(403);
    const persisted = await getGitHubInstallation(env.db, '999');
    expect(persisted?.user_id).toBe(userB.id);
  });

  // Regression: the primary account-ownership check rejects when the
  // installation's GitHub account does not match the caller's bound account id,
  // even for an installation that is not yet linked to anyone.
  it('rejects a callback whose installation account does not match the caller', async () => {
    const userA = await createTestUser(env.db, 'attacker', 'github', 'acc_a');
    // Installation belongs to some other GitHub account (id 9999), not A's.
    mockInstallationRepos({ login: 'stranger', id: 9999, type: 'User' });

    const state = await mintInstallState(userA.id, 'acc_a');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=888&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(403);
    expect(await getGitHubInstallation(env.db, '888')).toBeNull();
  });

  // Positive: a user installing on their own personal account (where the
  // installation's GitHub account id equals the user's bound account id)
  // succeeds and the installation is linked to them.
  it('links the installation when the account matches the caller', async () => {
    const user = await createTestUser(env.db, 'self', 'github', '7777');
    mockInstallationRepos({ login: 'self', id: 7777, type: 'User' });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=4242&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    // Redirects to the dashboard connections page on success.
    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '4242');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('7777');
  });

  // Regression: a reconnect / `setup_action=update` callback hits the EXISTING
  // row (conflict path). The callback just refetched the LIVE membership, so it
  // passes `refreshMembership: true` — the fresh repo list / selection MUST be
  // persisted. Before the fix, the conflict path dropped fresh membership and
  // newly-added repos / a widen-to-`all` stayed rejected until the next webhook.
  it('rolls fresh membership forward on a setup_action=update callback', async () => {
    const user = await createTestUser(env.db, 'reconnect', 'github', '7777');

    // Pre-seed a STALE existing install: only acme/app, selection 'selected'.
    await upsertGitHubInstallation(env.db, {
      installationId: '4243',
      userId: user.id,
      accountLogin: 'reconnect',
      accountId: '7777',
      accountType: 'User',
      repositories: [{ full_name: 'reconnect/app', id: 1 }],
      repositorySelection: 'selected',
    });

    // The callback refetches a WIDENED LIVE membership (a second repo added).
    const owner = { login: 'reconnect', id: 7777, type: 'User' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/installation/repositories')) {
          return Response.json({
            repository_selection: 'selected',
            repositories: [
              { full_name: 'reconnect/app', id: 1, owner },
              { full_name: 'reconnect/api', id: 2, owner },
            ],
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=4243&setup_action=update&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '4243');
    // Fresh membership rolled forward — the newly-added repo is now persisted.
    expect(persisted?.repositories).toEqual([
      { full_name: 'reconnect/app', id: 1 },
      { full_name: 'reconnect/api', id: 2 },
    ]);
    expect(persisted?.repository_selection).toBe('selected');
  });

  // Regression: an `all`-repository install must NOT enumerate or persist the
  // full repo list. Once page 1 reports `repository_selection: 'all'`, the
  // callback stops paginating — the cached array is never read for `all`
  // installs (every coverage check short-circuits on selection='all'; the
  // connect route resolves ids live) — and stores an empty `repositories`. This
  // guards against burning GitHub round trips + JSONB bloat for a large org.
  it('stops paginating and stores no repos for an all-repository install', async () => {
    const user = await createTestUser(env.db, 'allinstaller', 'github', '8888');
    const pagesFetched: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/installation/repositories')) {
          pagesFetched.push(new URL(url).searchParams.get('page') ?? '1');
          // A FULL page (100 repos) would normally trigger a page-2 fetch; the
          // `all` early-break must stop here regardless of the page being full.
          const repositories = Array.from({ length: 100 }, (_, i) => ({
            full_name: `acme/repo-${i}`,
            id: i + 1,
            owner: { login: 'self8888', id: 8888, type: 'User' },
          }));
          return Response.json({ repository_selection: 'all', repositories });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintInstallState(user.id, '8888');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=7000&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    // Only page 1 was fetched — the `all` branch broke before requesting page 2.
    expect(pagesFetched).toEqual(['1']);
    const persisted = await getGitHubInstallation(env.db, '7000');
    expect(persisted?.repository_selection).toBe('all');
    // The full repo list is NOT persisted for an `all` install.
    expect(persisted?.repositories).toEqual([]);
  });

  // (a): an ORGANIZATION install authorized via "user authorization on
  // install". The installation's derived account is the ORG (id 9001), which
  // differs from the caller's personal GitHub id (7777) — so the account-id
  // fallback would 403. But GitHub appends a `code`; exchanging it yields a user
  // token whose GET /user/installations includes installation_id 5000, which
  // authorizes the link.
  it('links an org install authorized via user-auth-on-install code', async () => {
    const user = await createTestUser(env.db, 'orgadmin', 'github', '7777');
    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [5000],
      // The code-holder IS the initiator: GET /user returns their personal id,
      // which matches the signed state's account id (7777).
      callerAccountId: 7777,
    });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=valid-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect(calls.tokenExchange).toBe(true);
    expect(calls.userInstallations).toBe(true);
    expect(calls.user).toBe(true);
    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBe(user.id);
    // Linked under the ORG account, not the caller's personal id.
    expect(persisted?.account_id).toBe('9001');
    expect(persisted?.account_type).toBe('Organization');
  });

  // (b): a code is present but GET /user/installations does NOT include the
  // installation_id (the user cannot manage it). The user-token path fails and
  // the org account id (9001) does not match the caller's personal id (7777),
  // so the callback 403s and nothing is linked.
  it('rejects an install whose code does not list the installation_id', async () => {
    const user = await createTestUser(env.db, 'outsider', 'github', '7777');
    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      // The user can manage some OTHER installation, but not 5000.
      userInstallationIds: [1234],
    });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=valid-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await getGitHubInstallation(env.db, '5000')).toBeNull();
  });

  // (c): regression preserved through the user-token path. An attacker
  // holding a victim's installation_id presents a `code`, but exchanging it
  // yields a user token whose installations do NOT include the victim's
  // installation_id. The user-token path fails, the org account id does not
  // match the attacker's bound id, so the callback 403s and — crucially — the
  // victim's existing ownership is left intact.
  it('does not re-own a victim installation when the code does not authorize it', async () => {
    const userB = await createTestUser(env.db, 'victim', 'github', '5555');
    const userA = await createTestUser(env.db, 'attacker', 'github', '4242');

    // B already owns installation 999.
    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: userB.id,
      accountLogin: 'victim',
      accountId: '5555',
      accountType: 'User',
      repositories: [{ full_name: 'victim/app', id: 1 }],
    });

    // A's code is valid, but A's accessible installations do not include 999.
    mockUserAuthInstall({
      owner: { login: 'victim', id: 5555, type: 'User' },
      userInstallationIds: [777],
    });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=999&code=attacker-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    const persisted = await getGitHubInstallation(env.db, '999');
    expect(persisted?.user_id).toBe(userB.id);
  });

  // (d): personal install with NO code still succeeds via the account-id
  // fallback (the App is not configured for user-auth-on-install). This is the
  // behavior every existing callback test relies on — kept green here.
  it('links a personal install via the account-id fallback when no code is present', async () => {
    const user = await createTestUser(env.db, 'solo', 'github', '8888');
    mockInstallationRepos({ login: 'solo', id: 8888, type: 'User' });

    const state = await mintInstallState(user.id, '8888');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6000&state=${encodeURIComponent(state)}`,
      ),
      // Note: user-OAuth env present but NO code -> fallback path is taken and
      // the token exchange is never attempted (mockInstallationRepos throws on
      // any non-repos fetch, proving the exchange is skipped).
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '6000');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('8888');
  });

  // Confused-deputy: an attacker mints an install URL bound to THEIR own GitHub
  // account id (111) and sends it to a victim org admin. The victim completes
  // the install, so the OAuth `code` exchanges to a token that CAN access the
  // org installation (user-token path is authorized). But the code-holder's own
  // GET /user id (222, the victim) does NOT match the signed state's account id
  // (111, the attacker) — so the install must be rejected and nothing linked.
  it('rejects an install whose code-holder is not the state initiator', async () => {
    const attacker = await createTestUser(env.db, 'attacker', 'github', '111');

    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 999, type: 'Organization' },
      // The (victim's) token CAN access the org installation 5000.
      userInstallationIds: [5000],
      // ...but the code-holder is the VICTIM (222), not the attacker (111).
      callerAccountId: 222,
    });

    // State is bound to the ATTACKER's own GitHub account id.
    const state = await mintInstallState(attacker.id, '111');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=victim-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('does not belong to the caller');
    expect(calls.user).toBe(true);
    // Nothing was linked — the org installation stays unclaimed.
    expect(await getGitHubInstallation(env.db, '5000')).toBeNull();
  });

  // Legitimate org install via the token path with the binding enforced. The
  // initiator's state account id (111) matches their own GET /user id (111),
  // and the org installation 5000 is in their accessible list — even though the
  // installation's derived account is the ORG (999, != 111), proving org
  // installs still work once the code-holder is confirmed to be the initiator.
  it('links an org install when the code-holder matches the state initiator', async () => {
    const initiator = await createTestUser(env.db, 'orgadmin', 'github', '111');

    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 999, type: 'Organization' },
      userInstallationIds: [5000],
      // The code-holder IS the initiator (111), matching the signed state.
      callerAccountId: 111,
    });

    const state = await mintInstallState(initiator.id, '111');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=initiator-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect(calls.user).toBe(true);
    expect(calls.userInstallations).toBe(true);
    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBe(initiator.id);
    // Linked under the ORG account (999), not the initiator's personal id.
    expect(persisted?.account_id).toBe('999');
    expect(persisted?.account_type).toBe('Organization');
  });

  // An install with NO repositories selected yet has no repo owner to derive the
  // account from. The callback must resolve the account AUTHORITATIVELY via the
  // App JWT (`GET /app/installations/:id`) and use that REAL id for the ownership
  // check + persistence — never fabricate `account_id = installationId`.
  it('resolves the real account via the App-JWT lookup for an empty-repos install', async () => {
    const user = await createTestUser(env.db, 'empty-install', 'github', '7777');
    // No repos → owner undefined; the App-JWT lookup returns the real account.
    mockEmptyInstallAccount({ account: { login: 'empty-owner', id: 7777, type: 'User' } });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6100&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    // The REAL account id (7777) matches the caller's bound id, so the ownership
    // check passes and the install links under the real account — NOT a
    // fabricated `account_id = installationId` (6100).
    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '6100');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('7777');
    expect(persisted?.account_login).toBe('empty-owner');
  });

  // Fail-closed: when the App-JWT account lookup fails for an empty-repos
  // install, the callback must 502 (not persist/check a fabricated account id).
  it('fails closed (502) when the App-JWT account lookup fails for an empty-repos install', async () => {
    const user = await createTestUser(env.db, 'empty-fail', 'github', '7777');
    mockEmptyInstallAccount({ account: null }); // lookup 500s → returns null

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6200&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('unable to resolve installation account');
    // Nothing was persisted (no fabricated row).
    expect(await getGitHubInstallation(env.db, '6200')).toBeNull();
  });
});
