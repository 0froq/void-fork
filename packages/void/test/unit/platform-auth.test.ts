import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  readWranglerOAuthCredential,
  resolvePlatformCloudflareCredential,
  wranglerAuthEnvironment,
} from '../../src/cli/platform-auth.ts';

afterEach(() => {
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
});

describe('platform Cloudflare authentication', () => {
  it('uses explicit environment credentials without invoking Wrangler', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'ci-token';
    const runWrangler = vi.fn();

    await expect(
      resolvePlatformCloudflareCredential({ interactive: false, runWrangler }),
    ).resolves.toEqual({ source: 'environment', token: 'ci-token' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('reads OAuth through the supported Wrangler command', () => {
    expect(
      readWranglerOAuthCredential(() => ({
        status: 0,
        stderr: '',
        stdout: JSON.stringify({ token: 'oauth-token', type: 'oauth' }),
      })),
    ).toEqual({ source: 'oauth', token: 'oauth-token' });
  });

  it('enables keyring storage before browser login', async () => {
    const calls: Array<string> = [];
    let tokenAttempts = 0;
    const credential = await resolvePlatformCloudflareCredential({
      confirmLogin: async () => true,
      interactive: true,
      runWrangler: (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'auth' && args[1] === 'token') {
          tokenAttempts++;
          return tokenAttempts === 1
            ? { status: 1, stderr: 'not logged in', stdout: '' }
            : {
                status: 0,
                stderr: '',
                stdout: JSON.stringify({ token: 'browser-token', type: 'oauth' }),
              };
        }
        return { status: 0, stderr: '', stdout: '' };
      },
    });

    expect(credential).toEqual({ source: 'oauth', token: 'browser-token' });
    expect(calls).toEqual([
      'auth keyring enable',
      'auth token --json',
      'login',
      'auth token --json',
    ]);
  });

  it('requires an explicit environment token in non-interactive environments', async () => {
    const runWrangler = vi.fn(() => ({ status: 1, stderr: 'not logged in', stdout: '' }));
    await expect(
      resolvePlatformCloudflareCredential({
        interactive: false,
        runWrangler,
      }),
    ).rejects.toThrow('set CLOUDFLARE_API_TOKEN in CI');
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('does not accept a Wrangler API token from an implicit plaintext profile', () => {
    expect(
      readWranglerOAuthCredential(() => ({
        status: 0,
        stderr: '',
        stdout: JSON.stringify({ token: 'implicit-token', type: 'api_token' }),
      })),
    ).toBeNull();
  });

  it('does not expose platform recovery or service secrets to Wrangler auth commands', () => {
    expect(
      wranglerAuthEnvironment({
        CF_ACCESS_CLIENT_SECRET: 'access-secret',
        DATABASE_URL: 'postgres://secret',
        PATH: '/bin',
        VOID_PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret',
        VOID_PLATFORM_RECOVERY_KEY: 'recovery-secret',
      }),
    ).toEqual({ CLOUDFLARE_AUTH_USE_KEYRING: 'true', PATH: '/bin' });
  });
});
