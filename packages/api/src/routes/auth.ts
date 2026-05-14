import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import {
  ensureGitHubPreviewRepoAccess,
  getGitHubPreviewRepoConfig,
  hasGitHubPreviewRepoAccess,
} from '../auth/github-preview.ts';
import { getGitHubAuthorizeUrl, exchangeCodeForToken, getGitHubUser } from '../auth/github.ts';
import {
  getGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getGoogleUser,
} from '../auth/google.ts';
import { hmacSignState, hmacVerifyState } from '../auth/hmac.ts';
import { signJwt } from '../auth/jwt.ts';
import { DEFAULT_DASHBOARD_URL } from '../constants.ts';
import {
  getUserByOAuthAccount,
  getUserByEmail,
  createUser,
  updateUser,
  createOAuthAccount,
  acceptInvitationByEmail,
  storeOAuthNonce,
  consumeOAuthNonce,
  storeAuthCode,
  consumeAuthCode,
} from '../db.ts';
import { sendWelcomeEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { isSignupAllowed, getAllowlist } from '../signup-allowlist.ts';

const DEFAULT_REDIRECT_URI = 'https://api.void.cloud/auth/callback';
const DASHBOARD_AUTH_CODE_TTL_SECONDS = 5 * 60;

const app = new Hono<ApiEnv>();

export function isAllowedRedirect(url: string, dashboardUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Localhost: allow any port, require exact hostname and http protocol
  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true;
  }

  // Dashboard: compare exact origin (protocol + hostname + port)
  const origin = dashboardUrl ?? 'https://dash.void.cloud';
  try {
    return parsed.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

// GET /auth/login?redirect=http://localhost:PORT/callback&provider=github|google
app.get('/login', async (c) => {
  const redirect = c.req.query('redirect');
  if (!redirect) {
    return c.json({ error: 'redirect parameter is required' }, 400);
  }

  if (!isAllowedRedirect(redirect, c.env.DASHBOARD_URL)) {
    return c.json({ error: 'redirect must be a localhost or dashboard URL' }, 400);
  }

  const provider = c.req.query('provider') ?? 'github';
  if (provider !== 'github' && provider !== 'google') {
    return c.json({ error: 'provider must be github or google' }, 400);
  }

  const nonce = crypto.randomUUID();

  // Store nonce in PostgreSQL so callback can validate it (prevents login CSRF / replay).
  // Not KV: login and callback can hit different CF colos, and KV's eventual consistency
  // would make the lookup flaky. PG also gives us atomic DELETE for true single-use.
  const db = c.get('db');
  await storeOAuthNonce(db, nonce, 600);

  const stateData = JSON.stringify({ redirect, nonce, provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, c.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;

  const redirectUri = c.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  // Bind nonce to this browser to prevent login CSRF / session swapping
  setCookie(c, 'oauth_nonce', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth/callback',
    maxAge: 600,
  });

  if (provider === 'google') {
    const url = getGoogleAuthorizeUrl(c.env.GOOGLE_CLIENT_ID, redirectUri, state);
    return c.redirect(url);
  }

  const url = getGitHubAuthorizeUrl(c.env.GITHUB_CLIENT_ID, redirectUri, state);
  return c.redirect(url);
});

// GET /auth/callback?code=...&state=...
app.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    return c.json({ error: 'missing code or state' }, 400);
  }

  // Verify state HMAC
  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    return c.json({ error: 'invalid state' }, 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, c.env.JWT_SECRET);
  if (!valid) {
    return c.json({ error: 'invalid state signature' }, 400);
  }

  const { redirect, nonce, provider } = JSON.parse(atob(stateEncoded)) as {
    redirect: string;
    nonce: string;
    provider?: string;
  };

  // Verify the nonce matches the cookie set during login redirect.
  // This binds the OAuth flow to the browser that initiated it,
  // preventing login CSRF / session swapping attacks.
  const cookieNonce = getCookie(c, 'oauth_nonce');
  if (!cookieNonce || cookieNonce !== nonce) {
    return c.json({ error: 'OAuth session mismatch' }, 400);
  }

  // Validate and consume nonce atomically (single-use, 10-minute TTL).
  // Uses PostgreSQL — not KV — for strong consistency across colos.
  const db = c.get('db');
  const nonceValid = await consumeOAuthNonce(db, nonce);
  if (!nonceValid) {
    return c.json({ error: 'invalid or expired OAuth state' }, 400);
  }

  // Clear the cookie only after successful validation so stale callbacks
  // from duplicate tabs don't invalidate a legitimate in-progress login.
  deleteCookie(c, 'oauth_nonce', { path: '/auth/callback' });

  // Re-validate redirect after decoding
  if (!isAllowedRedirect(redirect, c.env.DASHBOARD_URL)) {
    return c.json({ error: 'invalid redirect' }, 400);
  }

  const resolvedProvider = provider ?? 'github';
  let providerId: string;
  let login: string;
  let email: string | null;
  let emailVerified: boolean;

  if (resolvedProvider === 'google') {
    const redirectUri = c.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
    const googleToken = await exchangeGoogleCode(
      c.env.GOOGLE_CLIENT_ID,
      c.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri,
    );
    const googleUser = await getGoogleUser(googleToken);
    providerId = googleUser.id;
    login = googleUser.email;
    email = googleUser.email;
    emailVerified = googleUser.emailVerified;
  } else {
    const ghToken = await exchangeCodeForToken(
      c.env.GITHUB_CLIENT_ID,
      c.env.GITHUB_CLIENT_SECRET,
      code,
    );
    const ghUser = await getGitHubUser(ghToken);
    providerId = String(ghUser.id);
    login = ghUser.login;
    email = ghUser.email;
    emailVerified = ghUser.emailVerified;
  }
  const previewRepo = resolvedProvider === 'github' ? getGitHubPreviewRepoConfig(c.env) : null;

  // Upsert user — check oauth_accounts first, then email, then create
  let user = await getUserByOAuthAccount(db, resolvedProvider, providerId);
  if (user) {
    // Only update login/email when the provider matches the user's primary provider
    // (avoids overwriting GitHub username with Google email)
    if (user.provider === resolvedProvider) {
      // Only overwrite stored email when the new one is verified;
      // a transient /user/emails failure must not wipe the existing email.
      if (emailVerified) {
        await updateUser(db, user.id, login, email);
      } else {
        await updateUser(db, user.id, login, user.email);
      }
    }
  } else if (email && emailVerified) {
    // Link new provider to existing account with the same email
    const existing = await getUserByEmail(db, email);
    if (existing) {
      await createOAuthAccount(db, existing.id, resolvedProvider, providerId);
      user = existing;
    }
  }

  let createdUser = false;
  if (!user) {
    // Check signup allowlist (new users only)
    const enabled = await c.env.ROUTING.get('signup:enabled');
    if (enabled === 'true') {
      let allowedByRepoAccess = false;
      if (resolvedProvider === 'github' && previewRepo) {
        try {
          allowedByRepoAccess = await hasGitHubPreviewRepoAccess(previewRepo, login);
        } catch (err) {
          console.error(`[github-preview] Failed to check repo access for ${login}:`, err);
        }
      }

      const entries = allowedByRepoAccess ? [] : await getAllowlist(c.env.ROUTING);
      if (
        !allowedByRepoAccess &&
        !isSignupAllowed(resolvedProvider, login, emailVerified ? email : null, entries)
      ) {
        return c.redirect('/signup-restricted');
      }
    }
    user = await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      const newUser = await createUser(
        txDb,
        resolvedProvider,
        providerId,
        login,
        emailVerified ? email : null,
      );
      await createOAuthAccount(txDb, newUser.id, resolvedProvider, providerId);
      return newUser;
    });
    createdUser = true;
  }

  if (emailVerified && email) {
    try {
      await acceptInvitationByEmail(db, email, user.id);
    } catch (err) {
      console.error(`Failed to accept invitation for ${email} (user ${user.id}):`, err);
    }
    if (createdUser) {
      if (c.env.EMAIL) {
        c.executionCtx.waitUntil(
          sendWelcomeEmail(c.env.EMAIL, email, login).catch((err) =>
            console.error(`[welcome-email] Failed for ${email}:`, err),
          ),
        );
      }
    }
  }

  if (resolvedProvider === 'github') {
    if (previewRepo) {
      c.executionCtx.waitUntil(
        ensureGitHubPreviewRepoAccess(previewRepo, login).catch((err) =>
          console.error(`[github-preview] Failed to grant void-sdk/void access to ${login}:`, err),
        ),
      );
    }
  }

  // Sign JWT
  const jwt = await signJwt({ sub: user.id, login, aud: 'api' }, c.env.JWT_SECRET);

  const redirectUrl = new URL(redirect);

  if (redirectUrl.hostname === 'localhost' || redirectUrl.hostname === '127.0.0.1') {
    // CLI / local dev: token in query param (localhost-only, safe)
    redirectUrl.searchParams.set('token', jwt);
  } else {
    // Dashboard: short-lived auth code exchanged server-side, so the JWT never appears in the URL.
    // Stored in PostgreSQL (not KV) for strong cross-colo consistency and atomic single-use
    // via DELETE … RETURNING — same rationale as the OAuth nonce flow.
    const authCode = crypto.randomUUID();
    await storeAuthCode(db, authCode, jwt, DASHBOARD_AUTH_CODE_TTL_SECONDS);
    redirectUrl.searchParams.set('code', authCode);
  }

  return c.redirect(redirectUrl.toString());
});

// POST /auth/exchange — single-use code → JWT (called by dashboard callback)
app.post('/exchange', async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  if (!code) {
    return c.json({ error: 'missing code' }, 400);
  }

  const db = c.get('db');
  const jwt = await consumeAuthCode(db, code);
  if (!jwt) {
    return c.json({ error: 'invalid or expired code' }, 400);
  }

  return c.json({ token: jwt });
});

export default app;
