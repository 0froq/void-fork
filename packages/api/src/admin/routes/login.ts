import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { getGoogleAuthorizeUrl, exchangeCodeForToken, getGoogleUser } from '../../auth/google';
import { hmacSignState, hmacVerifyState } from '../../auth/hmac';
import { signJwt } from '../../auth/jwt';
import {
  getUserByOAuthAccount,
  getUserByEmail,
  updateUserProviderId,
  createOAuthAccount,
  storeOAuthNonce,
  consumeOAuthNonce,
} from '../../db';
import type { ApiEnv } from '../../env';

const app = new Hono<ApiEnv>();

// GET /login
app.get('/login', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head><title>Admin Login - Void</title></head>
<body style="font-family: monospace; line-height: 1.5">
<div style="max-width: 800px; margin: 0 auto; padding: 20px">
<h1>Void Admin</h1>
<p>Sign in with your admin account</p>
<p><a href="/admin/login/google">Sign in with Google</a></p>
</div>
</body>
</html>`);
});

// GET /login/google
app.get('/login/google', async (c) => {
  const redirectUri = new URL(c.req.url).origin + '/admin/callback';
  const nonce = crypto.randomUUID();
  await storeOAuthNonce(c.get('db'), nonce, 600);
  const stateData = JSON.stringify({ nonce });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, c.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;
  const url = getGoogleAuthorizeUrl(c.env.GOOGLE_CLIENT_ID, redirectUri, state);
  // Bind nonce to this browser to prevent login CSRF / session swapping
  setCookie(c, 'oauth_nonce', nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/admin/callback',
    maxAge: 600,
  });
  return c.redirect(url);
});

// GET /callback
app.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    return c.html('<h1>Login failed</h1><p>Missing code or state.</p>', 400);
  }

  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    return c.html('<h1>Login failed</h1><p>Invalid state.</p>', 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, c.env.JWT_SECRET);
  if (!valid) {
    return c.html('<h1>Login failed</h1><p>Invalid state signature.</p>', 400);
  }

  // Consume the nonce atomically — prevents replay of the callback URL
  let nonce: string;
  try {
    nonce = JSON.parse(atob(stateEncoded)).nonce;
  } catch {
    return c.html('<h1>Login failed</h1><p>Invalid state data.</p>', 400);
  }

  // Verify the nonce matches the cookie set during login redirect.
  // This binds the OAuth flow to the browser that initiated it,
  // preventing login CSRF / session swapping attacks.
  const cookieNonce = getCookie(c, 'oauth_nonce');
  if (!cookieNonce || cookieNonce !== nonce) {
    return c.html('<h1>Login failed</h1><p>OAuth session mismatch.</p>', 400);
  }

  const nonceValid = await consumeOAuthNonce(c.get('db'), nonce);
  if (!nonceValid) {
    return c.html('<h1>Login failed</h1><p>Invalid or expired login state.</p>', 400);
  }

  deleteCookie(c, 'oauth_nonce', { path: '/admin/callback' });

  const redirectUri = new URL(c.req.url).origin + '/admin/callback';
  const googleToken = await exchangeCodeForToken(
    c.env.GOOGLE_CLIENT_ID,
    c.env.GOOGLE_CLIENT_SECRET,
    code,
    redirectUri,
  );
  const googleUser = await getGoogleUser(googleToken);
  const providerId = googleUser.id;
  const login = googleUser.email;

  const db = c.get('db');
  let user = await getUserByOAuthAccount(db, 'google', providerId);

  // Fall back to email lookup — handles first login after seeding by email
  if (!user) {
    const byEmail = await getUserByEmail(db, login);
    if (byEmail && byEmail.provider === 'google') {
      // Backfill the real provider_id so future logins match directly
      await updateUserProviderId(db, byEmail.id, providerId);
      await createOAuthAccount(db, byEmail.id, 'google', providerId);
      user = byEmail;
    }
  }

  if (!user || user.role !== 'admin') {
    return c.html(
      '<h1>403 Forbidden</h1><p>Admin access required. You must have an admin account to sign in.</p>',
      403,
    );
  }

  const jwt = await signJwt({ sub: user.id, login, aud: 'admin' }, c.env.JWT_SECRET);

  setCookie(c, 'admin_token', jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });

  return c.redirect('/admin/');
});

// GET /logout
app.get('/logout', (c) => {
  deleteCookie(c, 'admin_token', { path: '/' });
  return c.redirect('/admin/login');
});

export default app;
