import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { defineHandler } from 'void';
import { getPublicApiUrl } from '../../lib/api.ts';

export const loader = defineHandler(async (c) => {
  const homeUrl = new URL('/', c.req.url).toString();

  // Production/staging: exchange short-lived auth code for JWT via API
  const code = c.req.query('code');
  if (code) {
    // Verify login nonce — prevents login CSRF / session fixation.
    // The nonce is set as a cookie on /login and included in the redirect URL.
    // The API passes it through, so we get it back as ?login_nonce=<value>.
    // Both the cookie and URL param must match — an attacker crafting
    // /auth/callback?code=xxx can't match the victim's cookie.
    const nonceCookie = getCookie(c, 'void_auth_nonce');
    const nonceParam = c.req.query('login_nonce');
    if (!nonceCookie || !nonceParam || nonceCookie !== nonceParam) {
      return c.redirect('/login');
    }
    deleteCookie(c, 'void_auth_nonce', { path: '/auth' });
    const apiUrl = getPublicApiUrl(c);
    const resp = await fetch(`${apiUrl}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!resp.ok) {
      return c.redirect('/login');
    }
    const { token } = (await resp.json()) as { token: string };
    const host = c.req.header('host') ?? '';
    setCookie(c, 'void_token', token, {
      httpOnly: true,
      secure: !(host.startsWith('localhost') || host.startsWith('127.0.0.1')),
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect(homeUrl);
  }

  // Local dev: token arrives as query param (localhost-only, not available in production)
  // Use Host header, not c.req.url — Workers Assets internal dispatch can set
  // c.req.url to localhost even in production.
  const token = c.req.query('token');
  if (token) {
    const host = c.req.header('host') ?? '';
    if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
      return c.redirect('/login');
    }
    setCookie(c, 'void_token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect(homeUrl);
  }

  return c.redirect('/login');
});
