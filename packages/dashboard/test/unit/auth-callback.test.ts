import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { loader } from '../../pages/auth/callback.server.ts';

function createApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  app.get('/auth/callback', (c) => {
    vi.stubGlobal('fetch', fetchImpl);
    return loader(c as never) as Response | Promise<Response>;
  });
  return app;
}

describe('dashboard auth callback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exchanges a dashboard auth code into a void_token cookie', async () => {
    const app = createApp(
      vi.fn(async () =>
        Response.json({
          token: 'dashboard-jwt',
        }),
      ) as typeof fetch,
    );

    const res = await app.request(
      'https://dash.staging.void.cloud/auth/callback?code=auth-code&login_nonce=nonce',
      {
        headers: {
          Cookie: 'void_auth_nonce=nonce',
          Host: 'dash.staging.void.cloud',
        },
        redirect: 'manual',
      },
      { API_URL: 'https://api.staging.void.cloud' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://dash.staging.void.cloud/');
    expect(res.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('void_auth_nonce=;'),
        expect.stringContaining('void_token=dashboard-jwt;'),
      ]),
    );
  });

  it('redirects failed exchanges to a clean login URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp(
      vi.fn(async () =>
        Response.json({ error: 'invalid or expired code' }, { status: 400 }),
      ) as typeof fetch,
    );

    const res = await app.request(
      'https://dash.staging.void.cloud/auth/callback?code=auth-code&login_nonce=nonce',
      {
        headers: {
          Cookie: 'void_auth_nonce=nonce',
          Host: 'dash.staging.void.cloud',
        },
        redirect: 'manual',
      },
      { API_URL: 'https://api.staging.void.cloud' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://dash.staging.void.cloud/login');
    expect(warn).toHaveBeenCalledWith(
      '[dashboard] /auth/exchange returned 400: invalid or expired code',
    );
  });
});
