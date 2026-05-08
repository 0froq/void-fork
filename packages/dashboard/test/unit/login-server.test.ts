import { describe, expect, it } from 'vitest';
import { getAuthCallbackForwardPath } from '../../pages/login.server.ts';

describe('login loader auth forwarding', () => {
  it('forwards OAuth codes that land on /login to the callback route', () => {
    expect(
      getAuthCallbackForwardPath(
        'https://dash.staging.void.cloud/login?login_nonce=abc&code=auth-code',
      ),
    ).toBe('/auth/callback?login_nonce=abc&code=auth-code');
  });

  it('forwards localhost token callbacks that land on /login', () => {
    expect(getAuthCallbackForwardPath('http://localhost:5173/login?token=jwt')).toBe(
      '/auth/callback?token=jwt',
    );
  });

  it('keeps regular login requests on the login page', () => {
    expect(getAuthCallbackForwardPath('https://dash.staging.void.cloud/login')).toBeNull();
    expect(
      getAuthCallbackForwardPath('https://dash.staging.void.cloud/login?login_nonce=abc'),
    ).toBeNull();
  });
});
