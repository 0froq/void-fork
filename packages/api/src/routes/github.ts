import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { hmacSignState, hmacVerifyState } from '../auth/hmac.ts';
import {
  CLI_CODE_CHALLENGE_METHOD,
  createCodeChallenge,
  isValidCodeVerifier,
} from '../auth/pkce.ts';
import { DEFAULT_DASHBOARD_URL } from '../constants.ts';
import type { Db } from '../db.ts';
import {
  createGitHubConnection,
  deleteGitHubConnection,
  getGitHubConnection,
  getGitHubInstallation,
  getGitHubInstallationsByUser,
  GitHubIdentityAlreadyLinkedError,
  GitHubIdentityConflictError,
  linkGitHubIdentity,
  linkGitHubInstallationToUser,
  getProject,
  terminateBuildsForProject,
  updateGitHubConnection,
  upsertGitHubInstallation,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import { listInstallationRepositories } from '../github/installation-repos.ts';
import { getInstallationAccount, getInstallationToken } from '../github/installation-token.ts';
import {
  authorizeInstallViaUserToken,
  exchangeCodeForUserAccountId,
  isAppUserOAuthConfigured,
} from '../github/user-installations.ts';
import { localhostRedirectResponse } from '../html-redirect.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { githubConnections, oauthAccounts } from '../schema.ts';
import type { Build, GitHubInstallation } from '../types.ts';
import { isLocalhostRedirect } from './auth.ts';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

// RFC 0074 link flow. The signed `state` carried through the GitHub
// App user-authorization redirect lives 10 minutes (the human takes the
// browser detour). The `link_code` minted by the public callback and handed
// back to the initiator's localhost lives 5 minutes (a tight machine-to-machine
// turnaround), mirroring the CLI auth-code TTL in `routes/auth.ts`.
const LINK_STATE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * The signed `state` minted by `GET /github/link-url` and verified by the public
 * `GET /github/link-callback`. Deliberately carries NO Void user id: the bind is
 * deferred to the authenticated `POST /github/link/complete`, keyed on the
 * bearer-token holder (RFC 0074 §"Threat L1"). `purpose` discriminates this
 * state from the install-flow state so the two can never be cross-replayed.
 */
type LinkState = {
  redirect: string;
  purpose: 'link';
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The stateless, HMAC-signed `link_code` minted by the public callback and
 * redirected to the initiator's localhost. It binds the GitHub identity proven
 * in the callback (`providerId`) to the PKCE challenge the initiator chose, so
 * only the holder of the matching `code_verifier` can complete the link. Still
 * NO Void user id — the completing bearer token is the only thing that decides
 * which account the identity binds to.
 */
type LinkCode = {
  providerId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * Mirror the EXACT `${btoa(JSON.stringify(payload))}.${signature}` scheme the
 * install-url + `/callback` already use (signed with `JWT_SECRET`).
 */
async function signLinkPayload(payload: LinkState | LinkCode, secret: string): Promise<string> {
  const encoded = btoa(JSON.stringify(payload));
  const signature = await hmacSignState(encoded, secret);
  return `${encoded}.${signature}`;
}

/**
 * Verify a signed link payload (state or code): split on the LAST `.`, check the
 * HMAC, then `JSON.parse(atob(...))`. Returns `null` on any failure (malformed,
 * bad signature, unparseable) so callers fail closed with a single 400.
 */
async function verifyLinkPayload<T>(token: string, secret: string): Promise<T | null> {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) {
    return null;
  }
  const encoded = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const valid = await hmacVerifyState(encoded, signature, secret);
  if (!valid) {
    return null;
  }
  try {
    return JSON.parse(atob(encoded)) as T;
  } catch {
    return null;
  }
}

// The GitHub App user-OAuth callback URL for THIS environment, derived from the
// request origin (no new env var). link-url sends it as redirect_uri on authorize;
// link-callback MUST send the byte-identical value on the token exchange (GitHub
// OAuth requires redirect_uri to match when present on authorize).
function linkCallbackUrl(context: Context<ApiEnv>): string {
  return new URL('/github/link-callback', new URL(context.req.url).origin).toString();
}

/**
 * True only when all GitHub App credentials are configured. Env vars are
 * strings (Cloudflare passes everything as strings), so we exact-string check
 * presence. The install/callback routes return 503 when this is false so the
 * feature is inert in environments without the App wired up.
 */
function isGitHubAppConfigured(env: ApiEnv['Bindings']): boolean {
  return (
    typeof env.GITHUB_APP_ID === 'string' &&
    env.GITHUB_APP_ID !== '' &&
    typeof env.GITHUB_APP_PRIVATE_KEY === 'string' &&
    env.GITHUB_APP_PRIVATE_KEY !== ''
  );
}

/**
 * Resolve a repo's immutable numeric id LIVE via `GET /repos/:full_name`,
 * authenticated with the installation token. Used by the connect route for
 * `all`-repos installs, where the cached `repositories` array is irrelevant (it
 * doesn't enumerate every covered repo). Returns `null` on any non-ok response
 * (e.g. 404 for a repo the installation can't see) so the caller fails closed.
 */
async function resolveRepositoryId(
  env: ApiEnv['Bindings'],
  installationId: string,
  repoFullName: string,
): Promise<number | null> {
  const token = await getInstallationToken(env, installationId);
  const res = await fetch(`${GITHUB_API_BASE}/repos/${repoFullName}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'void-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { id?: number };
  return typeof data.id === 'number' ? data.id : null;
}

/**
 * The caller's numeric GitHub account id (their `github` OAuth `provider_id`),
 * or `null` when the user has no linked GitHub identity (e.g. signed in via
 * Google only). This is the same value matched against
 * `github_installations.account_id` by `linkGitHubInstallationToUser`, so it is
 * the GitHub-side proof that the caller controls an installation's account.
 */
async function getCallerGitHubAccountId(db: Db, userId: string): Promise<string | null> {
  // Deterministic: pick the earliest-linked github identity. Without an
  // explicit ordering the row chosen by `limit(1)` is arbitrary, so a stray
  // second github row (RFC 0074 enforces one per account, but defends in depth)
  // would sign a nondeterministic account id into install `state`.
  const [row] = await db
    .select({ providerId: oauthAccounts.provider_id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, 'github')))
    .orderBy(asc(oauthAccounts.created_at))
    .limit(1);
  return row?.providerId ?? null;
}

/**
 * Derive the installation's account (login/id/type) from a repo owner — every
 * repo in an installation shares the owning account. Returns null when no repo
 * owner is available (e.g. an install with no repositories selected yet); the
 * caller then resolves the account authoritatively via the App JWT
 * (`getInstallationAccount`) rather than fabricating a placeholder id.
 */
function deriveAccountFromRepositories(
  owner: { login?: string; id?: number; type?: string } | undefined,
): { login: string; id: string; type: GitHubInstallation['account_type'] } | null {
  if (owner && typeof owner.login === 'string' && typeof owner.id === 'number') {
    return {
      login: owner.login,
      id: String(owner.id),
      type: owner.type === 'Organization' ? 'Organization' : 'User',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// /github — connect/install flow. Mounted OUTSIDE the global /projects auth, so
// each route applies (or omits) `authMiddleware` explicitly. The OAuth-style
// callback is public and authenticated via the signed HMAC state instead.
// ---------------------------------------------------------------------------
export const githubRoutes = new Hono<ApiEnv>()

  // Begin a GitHub App install — return the install URL the dashboard opens.
  // State binds the caller's user id, their GitHub account id, and a nonce so
  // the public callback can resolve the user AND verify (against GitHub) that
  // they own the installation, without a session.
  .get('/install-url', authMiddleware, async (context) => {
    const slug = context.env.GITHUB_APP_SLUG;
    if (typeof slug !== 'string' || slug === '') {
      return context.json({ error: 'GitHub App is not configured' }, 503);
    }

    const user = context.get('user');

    // Bind the caller's GitHub account id into the (signed) state. The public
    // callback uses it to prove — against GitHub — that the caller actually
    // owns the installation they are claiming. A user without a linked GitHub
    // identity cannot establish that proof, so they cannot connect.
    const githubAccountId = await getCallerGitHubAccountId(context.get('db'), user.id);
    if (githubAccountId === null) {
      return context.json({ error: 'github_identity_required' }, 403);
    }

    const stateData = JSON.stringify({
      userId: user.id,
      githubAccountId,
      nonce: crypto.randomUUID(),
    });
    const stateEncoded = btoa(stateData);
    const signature = await hmacSignState(stateEncoded, context.env.JWT_SECRET);
    const state = `${stateEncoded}.${signature}`;

    const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
    return context.json({ url });
  })

  // List the caller's linked installations.
  .get('/installations', authMiddleware, async (context) => {
    const user = context.get('user');
    const installations = await getGitHubInstallationsByUser(context.get('db'), user.id);
    return context.json(installations);
  })

  // -------------------------------------------------------------------------
  // RFC 0074 — authenticated GitHub-identity link flow (deferred bind).
  //
  // A GitHub user authorizing in their browser must end up linked to the Void
  // account that ran the CLI (the bearer-token holder), NOT to a user id baked
  // into the OAuth state. Binding in the public callback to a state-embedded
  // user id would be an account-linking CSRF: an attacker mints a link URL,
  // phishes a victim into authorizing, and the victim's GitHub binds to the
  // attacker. We defeat that by deferring the bind — the public callback only
  // mints a PKCE-bound `link_code` and redirects it to the initiator's
  // localhost; the bind happens in the authenticated `POST /link/complete`
  // keyed on the token-holder. An attacker can only ever link their own
  // identity.
  // -------------------------------------------------------------------------

  // Begin the link flow — return the GitHub App user-authorization URL the CLI
  // opens in the user's browser. The signed state carries the localhost
  // redirect + PKCE challenge and an expiry, but NO Void user id.
  .get('/link-url', authMiddleware, async (context) => {
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(
        {
          error: 'github_oauth_not_configured',
          message: 'GitHub App user OAuth is not configured',
        },
        503,
      );
    }

    const redirect = context.req.query('redirect');
    const codeChallenge = context.req.query('code_challenge');
    const codeChallengeMethod = context.req.query('code_challenge_method');

    if (!redirect) {
      return context.json({ error: 'redirect parameter is required' }, 400);
    }
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(redirect);
    } catch {
      return context.json({ error: 'redirect must be a localhost URL' }, 400);
    }
    if (!isLocalhostRedirect(redirectUrl)) {
      return context.json({ error: 'redirect must be a localhost URL' }, 400);
    }
    if (!codeChallenge) {
      return context.json({ error: 'code_challenge is required' }, 400);
    }
    // Method is optional, but if present it MUST be S256 (the only method we
    // verify against in /complete) — mirror the CLI-login PKCE guard.
    if (codeChallengeMethod !== undefined && codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD) {
      return context.json({ error: 'code_challenge_method must be S256' }, 400);
    }

    const state: LinkState = {
      redirect,
      purpose: 'link',
      codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_STATE_TTL_MS,
    };
    const signedState = await signLinkPayload(state, context.env.JWT_SECRET);

    // The App user-authorization URL. GitHub Apps don't take an OAuth `scope`
    // param — the App's permissions govern, and `GET /user` works with any
    // user token. The callback URL is derived from THIS request's origin so it
    // resolves correctly per environment (prod/staging/local) without a new env
    // var — same host the CLI just hit to reach this route.
    const callbackUrl = linkCallbackUrl(context);
    const url =
      `https://github.com/login/oauth/authorize?client_id=${context.env.GITHUB_APP_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(callbackUrl)}` +
      `&state=${encodeURIComponent(signedState)}`;

    return context.json({ url });
  })

  // Public link callback. GitHub redirects the browser here after the user
  // authorizes. Trust is established via the signed state minted at /link-url;
  // there is no session. This route NEVER binds an identity — it only proves
  // which GitHub account authorized and hands a PKCE-bound `link_code` back to
  // the initiator's localhost.
  .get('/link-callback', async (context) => {
    const code = context.req.query('code');
    const stateParam = context.req.query('state');

    if (!stateParam) {
      return context.json({ error: 'missing state' }, 400);
    }
    const state = await verifyLinkPayload<LinkState>(stateParam, context.env.JWT_SECRET);
    if (!state || state.purpose !== 'link') {
      return context.json({ error: 'invalid state' }, 400);
    }
    if (typeof state.exp !== 'number' || Date.now() >= state.exp) {
      return context.json({ error: 'invalid state' }, 400);
    }
    if (typeof state.redirect !== 'string' || typeof state.codeChallenge !== 'string') {
      return context.json({ error: 'invalid state' }, 400);
    }
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(state.redirect);
    } catch {
      return context.json({ error: 'invalid state' }, 400);
    }
    // Re-validate the redirect at use time — it is the only place we send the
    // link_code, so it must still be a localhost URL even though /link-url
    // already checked it (defense in depth against a forged-but-valid state).
    if (!isLocalhostRedirect(redirectUrl)) {
      return context.json({ error: 'invalid state' }, 400);
    }

    if (!code) {
      // GitHub denial / missing code. State + redirect are validated, so bounce the
      // error to the CLI's localhost listener (instead of JSON on the API host, which
      // never reaches the listener → `void github link` hangs until timeout). The
      // merged CLI's describeError surfaces `?error=`.
      redirectUrl.searchParams.set('error', context.req.query('error') || 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    // Exchange the App user-OAuth code for the authorizing user's numeric GitHub
    // account id. Pure identity — NO installation. Null on any failure.
    const providerId = await exchangeCodeForUserAccountId(
      context.env,
      code,
      linkCallbackUrl(context),
    );
    if (providerId === null) {
      // Exchange/identity failure. Same rationale as the missing-code branch:
      // bounce to the CLI's localhost so the failure surfaces instead of hanging.
      redirectUrl.searchParams.set('error', 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    // Mint a stateless, PKCE-bound link_code and redirect it to the initiator's
    // localhost. The bind itself is deferred to the authenticated /complete.
    const linkCode: LinkCode = {
      providerId,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_CODE_TTL_MS,
    };
    const signedLinkCode = await signLinkPayload(linkCode, context.env.JWT_SECRET);

    redirectUrl.searchParams.set('link_code', signedLinkCode);
    // 200 + JS redirect, not 302 — the redirect target is always localhost
    // (validated above via isLocalhostRedirect) and `wrangler dev` mangles
    // `Location: http://localhost:*` headers (see html-redirect.ts / meta/lessons.md),
    // which would otherwise drop the link_code and stall local `void github link`.
    return localhostRedirectResponse(redirectUrl.toString());
  })

  // Complete the link — the ONLY place an identity is bound. Authenticated:
  // the bind is keyed on the bearer-token holder (`context.get('user').id`),
  // never on anything carried in the link flow. Requires a valid PKCE verifier
  // matching the link_code's challenge, so only the initiator (who minted the
  // challenge) can redeem the code.
  .post('/link/complete', authMiddleware, async (context) => {
    const body = await context.req
      .json<{ link_code?: unknown; code_verifier?: unknown }>()
      .catch(() => null);
    if (!body || typeof body.link_code !== 'string' || typeof body.code_verifier !== 'string') {
      return context.json({ error: 'link_code and code_verifier are required' }, 400);
    }

    const linkCode = await verifyLinkPayload<LinkCode>(body.link_code, context.env.JWT_SECRET);
    if (!linkCode || typeof linkCode.providerId !== 'string') {
      return context.json({ error: 'invalid link_code' }, 400);
    }
    if (typeof linkCode.exp !== 'number' || Date.now() >= linkCode.exp) {
      return context.json({ error: 'invalid link_code' }, 400);
    }

    // PKCE: the verifier must be well-formed AND its S256 challenge must equal
    // the one bound into the link_code. The method must be S256.
    if (
      linkCode.codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD ||
      !isValidCodeVerifier(body.code_verifier) ||
      (await createCodeChallenge(body.code_verifier)) !== linkCode.codeChallenge
    ) {
      return context.json({ error: 'invalid_verifier' }, 400);
    }

    const user = context.get('user');
    try {
      const result = await linkGitHubIdentity(context.get('db'), user.id, linkCode.providerId);

      // Backfill GitHub App installations created before this user linked their
      // github identity — same best-effort claim the login callback runs
      // (auth.ts). `providerId` is matched against `github_installations.account_id`.
      // Best-effort: a backfill failure must NEVER fail the link.
      try {
        await linkGitHubInstallationToUser(context.get('db'), linkCode.providerId, user.id);
      } catch (err) {
        console.error(`[github-link] Failed to backfill installations for ${user.id}:`, err);
      }

      return context.json({ status: result });
    } catch (error) {
      if (error instanceof GitHubIdentityAlreadyLinkedError) {
        return context.json({ error: 'github_already_linked' }, 409);
      }
      if (error instanceof GitHubIdentityConflictError) {
        return context.json({ error: 'github_identity_conflict' }, 409);
      }
      throw error;
    }
  })

  // Public install callback. GitHub redirects the browser here after the user
  // completes (or cancels) an install. Trust is established via the signed
  // state minted by `/install-url`; there is no session cookie.
  .get('/callback', async (context) => {
    if (!isGitHubAppConfigured(context.env)) {
      return context.json({ error: 'GitHub App is not configured' }, 503);
    }

    const installationId = context.req.query('installation_id');
    const state = context.req.query('state');
    // Present only when the App has "Request user authorization (OAuth) during
    // installation" enabled. Used to authorize org installs (see below).
    const code = context.req.query('code');

    if (!state) {
      return context.json({ error: 'missing state' }, 400);
    }

    // Verify the state HMAC (same scheme as auth.ts).
    const dotIndex = state.lastIndexOf('.');
    if (dotIndex === -1) {
      return context.json({ error: 'invalid state' }, 400);
    }
    const stateEncoded = state.slice(0, dotIndex);
    const signature = state.slice(dotIndex + 1);
    const valid = await hmacVerifyState(stateEncoded, signature, context.env.JWT_SECRET);
    if (!valid) {
      return context.json({ error: 'invalid state signature' }, 400);
    }

    let userId: string;
    let stateGitHubAccountId: string;
    try {
      const parsed = JSON.parse(atob(stateEncoded)) as {
        userId?: unknown;
        githubAccountId?: unknown;
      };
      if (typeof parsed.userId !== 'string' || parsed.userId === '') {
        return context.json({ error: 'invalid state' }, 400);
      }
      // Older states minted before the ownership check carried no
      // `githubAccountId`; reject them rather than binding unverifiably.
      if (typeof parsed.githubAccountId !== 'string' || parsed.githubAccountId === '') {
        return context.json({ error: 'invalid state' }, 400);
      }
      userId = parsed.userId;
      stateGitHubAccountId = parsed.githubAccountId;
    } catch {
      return context.json({ error: 'invalid state' }, 400);
    }

    // `setup_action` is `'install'` on a fresh install, `'update'` when the
    // user edits repo selection. Either way `installation_id` must be present;
    // its absence means the user cancelled.
    if (!installationId) {
      return context.json({ error: 'missing installation_id' }, 400);
    }

    // Mint an installation token and read the installation's repositories. The
    // installation token does NOT authorize `GET /app/installations/:id` (that
    // needs the App JWT), so account metadata is derived from a repo owner —
    // every repo in an installation shares the owning account.
    const token = await getInstallationToken(context.env, installationId);
    const { repositories, owner, repositorySelection } = await listInstallationRepositories(token);
    // Fast path: derive the owning account from a repo owner (every repo in an
    // installation shares it). When the installation has NO repositories yet,
    // there is no owner to derive from — resolve the account AUTHORITATIVELY via
    // the App JWT (`GET /app/installations/:id`) instead of fabricating an id. A
    // failed lookup fails closed (502): persisting/checking a fabricated id would
    // wrongly reject a valid empty install and store a garbage account_id that
    // later breaks the sign-in backfill and the OIDC owner-guard.
    let account = deriveAccountFromRepositories(owner);
    if (account === null) {
      const resolved = await getInstallationAccount(context.env, installationId);
      if (resolved === null) {
        return context.json({ error: 'unable to resolve installation account' }, 502);
      }
      account = { login: resolved.login, id: resolved.accountId, type: resolved.type };
    }

    // Ownership check. Two paths, in order:
    //
    // 1. User-authorization-on-install (preferred; supports BOTH personal and
    //    org installs). When the App has "Request user authorization (OAuth)
    //    during installation" enabled, GitHub appends a `code` to this
    //    callback. We exchange it for a transient USER-to-server token and
    //    confirm `installation_id` is in the user's accessible installations
    //    (`GET /user/installations`) — which lists every installation the user
    //    can manage, including on organizations whose account id differs from
    //    the user's personal id. The token is used transiently and discarded.
    //
    // 2. Personal account-id match (fallback; personal installs only). When no
    //    `code` is present (App not configured for user-auth-on-install), the
    //    installation's GitHub account must equal the personal GitHub id bound
    //    into the signed state at /install-url. Org installs without a code
    //    still 403 here — the safe default. Enabling org support is an
    //    ops/config item: turn on user-auth-on-install on the GitHub App and
    //    set GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET.
    //
    // Either way the owner-guard backstop below still applies, so a valid state
    // alone never lets one Void user claim another's installation.
    const authResult =
      typeof code === 'string' && code !== ''
        ? await authorizeInstallViaUserToken(context.env, code, installationId)
        : { authorized: false, callerAccountId: null };

    if (authResult.authorized) {
      // Token path: the person who completed the OAuth code must BE the user who
      // initiated the install (whose GitHub account id is in the signed state).
      // This still allows org installs — the state encodes the INITIATOR's
      // account id, not the org's, and the user-token path already proved they
      // can access the org installation.
      if (
        authResult.callerAccountId === null ||
        authResult.callerAccountId !== stateGitHubAccountId
      ) {
        return context.json({ error: 'installation does not belong to the caller' }, 403);
      }
    } else if (account.id !== stateGitHubAccountId) {
      // Fallback path (no usable code / app-user OAuth not configured): require
      // the installation's own account to match the caller's stored GitHub
      // account id.
      return context.json({ error: 'installation does not belong to the caller' }, 403);
    }

    // Backstop: never re-own an installation already linked to a *different*
    // Void user. Defends against account-id collisions/derivation gaps and the
    // unconditional adopt-userId behavior of upsertGitHubInstallation.
    const existing = await getGitHubInstallation(context.get('db'), installationId);
    if (existing && existing.user_id !== null && existing.user_id !== userId) {
      return context.json({ error: 'installation already linked to another user' }, 403);
    }

    await upsertGitHubInstallation(context.get('db'), {
      installationId,
      userId,
      accountLogin: account.login,
      accountId: account.id,
      accountType: account.type,
      repositories,
      // Record GitHub's `repository_selection` so an `all`-repos install is
      // recognized without waiting for a webhook to flip it. The webhook
      // `installation` handler keeps it in sync afterward.
      repositorySelection,
      // We just refetched the LIVE membership via `listInstallationRepositories`,
      // so on reconnect / `setup_action=update` (existing row = conflict path)
      // this data is authoritative and must roll the cache forward. Without this,
      // newly-added repos or a widen-to-`all` stay rejected by the connect/push/
      // OIDC resolvers until the next webhook arrives.
      refreshMembership: true,
    });

    // Redirect to the dashboard connections page. Prod DASHBOARD_URL is https,
    // so the wrangler localhost-redirect mangling (see lessons.md) does not
    // apply here.
    const dashboardUrl = context.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
    return context.redirect(`${dashboardUrl}/settings/connections`);
  });

// ---------------------------------------------------------------------------
// /projects — per-project connection CRUD. Mounted UNDER the global
// `app.use('/projects/*', authMiddleware)`, so auth is already applied; each
// route does the project-ownership check (mirrors routes/domains.ts).
// ---------------------------------------------------------------------------
export const githubProjectRoutes = new Hono<ApiEnv>()

  // Connect a project to a repo within one of the caller's installations.
  .post('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const body = await context.req.json<{
      installationId?: unknown;
      repoFullName?: unknown;
      branch?: unknown;
      buildExecutor?: unknown;
    }>();

    if (typeof body.installationId !== 'string' || body.installationId === '') {
      return context.json({ error: 'installationId is required' }, 400);
    }
    if (typeof body.repoFullName !== 'string' || body.repoFullName === '') {
      return context.json({ error: 'repoFullName is required' }, 400);
    }
    if (
      body.buildExecutor !== undefined &&
      body.buildExecutor !== 'container' &&
      body.buildExecutor !== 'github_actions'
    ) {
      return context.json({ error: 'invalid buildExecutor' }, 400);
    }
    if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch === '')) {
      return context.json({ error: 'invalid branch' }, 400);
    }

    // The installation must belong to the caller and grant access to the repo.
    const installation = await getGitHubInstallation(context.get('db'), body.installationId);
    if (!installation || installation.user_id !== context.get('user').id) {
      return context.json({ error: 'installation not found' }, 404);
    }
    // The installation must be active. A suspended/deleted install can still
    // carry cached repos, but every build resolver requires status='active', so
    // connecting it would produce a connection that never builds.
    if (installation.status !== 'active') {
      return context.json({ error: 'installation is not active' }, 409);
    }
    // Resolve the repo's immutable numeric id. `repo_full_name` is mutable
    // (rename/delete/name-reuse), so webhook + OIDC routing keys on this id
    // instead. Two paths, keyed off the install's `repository_selection`:
    //
    //   - `all`: the install covers every repo in the account (including ones
    //     created after install), so the cached `repositories` array doesn't
    //     enumerate them. Resolve the id LIVE via `GET /repos/:full_name`; a
    //     non-ok response (e.g. the repo isn't actually covered) fails closed
    //     with the same 400 as the membership miss.
    //   - `selected`: the cached set is authoritative — look up by name. Still
    //     400s when absent.
    let repositoryId: number;
    if (installation.repository_selection === 'all') {
      const resolvedId = await resolveRepositoryId(
        context.env,
        body.installationId,
        body.repoFullName,
      );
      if (resolvedId === null) {
        return context.json({ error: 'repository not accessible by installation' }, 400);
      }
      repositoryId = resolvedId;
    } else {
      const matchedRepo = installation.repositories.find(
        (repo) => repo.full_name === body.repoFullName,
      );
      if (!matchedRepo) {
        return context.json({ error: 'repository not accessible by installation' }, 400);
      }
      repositoryId = matchedRepo.id;
    }

    const existing = await getGitHubConnection(context.get('db'), projectId);
    if (existing) {
      return context.json({ error: 'project already connected' }, 409);
    }

    const connection = await createGitHubConnection(context.get('db'), {
      projectId,
      installationId: body.installationId,
      repoFullName: body.repoFullName,
      repositoryId: String(repositoryId),
      branch: body.branch,
      buildExecutor: body.buildExecutor,
    });

    return context.json(connection);
  })

  // Read the project's connection.
  .get('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const connection = await getGitHubConnection(context.get('db'), projectId);
    if (!connection) {
      return context.json({ error: 'connection not found' }, 404);
    }

    return context.json(connection);
  })

  // Update branch / build executor.
  .patch('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    const connection = await getGitHubConnection(context.get('db'), projectId);
    if (!connection) {
      return context.json({ error: 'connection not found' }, 404);
    }

    const body = await context.req.json<{ branch?: unknown; buildExecutor?: unknown }>();
    if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch === '')) {
      return context.json({ error: 'invalid branch' }, 400);
    }
    if (
      body.buildExecutor !== undefined &&
      body.buildExecutor !== 'container' &&
      body.buildExecutor !== 'github_actions'
    ) {
      return context.json({ error: 'invalid buildExecutor' }, 400);
    }
    const newBranch: string | undefined = body.branch;
    const newExecutor = body.buildExecutor as Build['executor'] | undefined;

    // A branch or executor change orphans any in-flight build for the OLD config:
    // its deploy token must be revoked so a build started for the prior
    // branch/executor can't keep publishing after the config moves. Terminalize
    // those builds under the same connection-row lock as the update so an
    // in-flight OIDC exchange (which re-reads + locks the row) is serialized.
    // Only a REAL change invalidates builds — a no-op PATCH (value unchanged, or
    // field omitted) terminalizes nothing.
    const { cancelled, updated, gone } = await context.get('db').transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.project_id, projectId))
        .for('update');

      // Re-read the connection UNDER the lock: the pre-tx `connection` snapshot
      // can be stale if a concurrent PATCH or disconnect/reconnect committed
      // between that read and this lock. The locked row is authoritative — both
      // change-detection AND the terminate branch/executor are derived from it,
      // so we never terminalize builds for a stale branch/executor.
      const current = await getGitHubConnection(txDb, projectId);
      if (!current) {
        // The connection was deleted in the race; respond 404 outside the tx.
        return { cancelled: [], updated: null, gone: true };
      }

      const terminated: Array<{
        id: string;
        executor: Build['executor'];
        instance_type: string | null;
      }> = [];
      if (newBranch !== undefined && newBranch !== current.branch) {
        terminated.push(
          ...(await terminateBuildsForProject(txDb, projectId, {
            branch: current.branch,
            reason: 'branch changed',
          })),
        );
      }
      if (newExecutor !== undefined && newExecutor !== current.build_executor) {
        terminated.push(
          ...(await terminateBuildsForProject(txDb, projectId, {
            executor: current.build_executor,
            reason: 'executor changed',
          })),
        );
      }

      await updateGitHubConnection(txDb, projectId, {
        branch: newBranch,
        buildExecutor: newExecutor,
      });
      const next = await getGitHubConnection(txDb, projectId);
      return { cancelled: terminated, updated: next, gone: false };
    });

    if (gone) {
      return context.json({ error: 'connection not found' }, 404);
    }

    // AFTER the tx commits (never while holding the connection lock), best-effort
    // stop the container DOs for any cancelled container builds.
    await cancelContainerBuildDos(context.env, cancelled, 'project disconnected');

    return context.json(updated);
  })

  // Disconnect the project.
  .delete('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const project = await getProject(context.get('db'), projectId);
    if (!project) {
      return context.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== context.get('user').id) {
      return context.json({ error: 'forbidden' }, 403);
    }

    // Terminalize ALL in-flight builds (queued + active, both executors) for
    // this project BEFORE dropping the connection, then drop it — in one tx
    // under a connection-row lock. Terminalizing revokes each build's deploy
    // token (the middleware guard rejects a token whose bound build is no
    // longer active), so an active container build that already minted a
    // VOID_TOKEN can't keep publishing from a now-disconnected repo. GitHub
    // Actions builds also stop pinning a concurrency slot (their workflow_run
    // completion webhook resolves the CURRENT connection — once it's gone the
    // completion is ignored and the build would otherwise stay active forever).
    const cancelled = await context.get('db').transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Lock the connection row(s) so an in-flight OIDC exchange (which re-reads +
      // FOR UPDATE-locks the same row before inserting its build) is serialized:
      // whichever commits first wins, and a build created just before this commit
      // is caught by the terminate step below.
      await tx
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.project_id, projectId))
        .for('update');
      const terminated = await terminateBuildsForProject(txDb, projectId, {
        reason: 'project disconnected',
      });
      await deleteGitHubConnection(txDb, projectId);
      return terminated;
    });

    // AFTER the tx commits (never while holding the connection lock), best-effort
    // stop the container DOs for any cancelled container builds.
    await cancelContainerBuildDos(context.env, cancelled, 'project disconnected');

    return context.json({ ok: true });
  });
