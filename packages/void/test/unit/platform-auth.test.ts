import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CloudflareAuthRunResult } from '../../src/cli/cloudflare-auth.ts';
import { cloudflareAuthEnvironment } from '../../src/cli/cloudflare-auth.ts';
import {
  assertPlatformOperatorCredentialCanApplyPlan,
  readWranglerOAuthCredential,
  resolvePlatformCloudflareCredential,
  resolvePlatformCloudflareCredentialWithInput,
} from '../../src/cli/platform-auth.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
  vi.restoreAllMocks();
});

describe('platform Cloudflare authentication', () => {
  it('requires an API token before browser OAuth applies zone or DNS writes', () => {
    const action = (kind: 'dns-record' | 'zone', action: 'create' | 'reuse') => ({
      action,
      id: action === 'reuse' ? `${kind}-id` : null,
      key: kind,
      kind,
      name: 'example.com',
      reason: 'test',
    });

    expect(() =>
      assertPlatformOperatorCredentialCanApplyPlan(
        { source: 'oauth', token: 'browser-token' },
        { actions: [action('zone', 'create'), action('dns-record', 'create')] },
      ),
    ).toThrow('Account → Zone → Edit and Zone → DNS → Edit');
    expect(() =>
      assertPlatformOperatorCredentialCanApplyPlan(
        { source: 'oauth', token: 'browser-token' },
        { actions: [action('zone', 'reuse'), action('dns-record', 'reuse')] },
      ),
    ).not.toThrow();
    expect(() =>
      assertPlatformOperatorCredentialCanApplyPlan(
        { source: 'environment', token: 'scoped-token' },
        { actions: [action('zone', 'create'), action('dns-record', 'create')] },
      ),
    ).not.toThrow();
  });

  it('uses explicit environment credentials without invoking Wrangler', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'ci-token';
    const runWrangler = vi.fn();

    await expect(
      resolvePlatformCloudflareCredential({ interactive: false, runWrangler }),
    ).resolves.toEqual({ source: 'environment', token: 'ci-token' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('reads OAuth through the Cloudflare session command', async () => {
    await expect(
      readWranglerOAuthCredential(() => ({
        status: 0,
        stderr: '',
        stdout: '',
        data: { token: 'oauth-token', type: 'oauth' },
      })),
    ).resolves.toEqual({ source: 'oauth', token: 'oauth-token' });
  });

  it('uses cf browser login when no session exists', async () => {
    const calls: Array<string> = [];
    let tokenAttempts = 0;
    const credential = await resolvePlatformCloudflareCredential({
      interactive: true,
      runWrangler: (args) => {
        calls.push(args.type);
        if (args.type === 'auth.token') {
          tokenAttempts++;
          return tokenAttempts === 1
            ? { status: 1, stderr: 'not logged in', stdout: '', data: '' }
            : {
                status: 0,
                stderr: '',
                stdout: '',
                data: { token: 'browser-token', type: 'oauth' },
              };
        }
        return { status: 0, stderr: '', stdout: '', data: '' };
      },
    });

    expect(credential).toEqual({ source: 'oauth', token: 'browser-token' });
    expect(calls).toEqual(['auth.token', 'auth.login', 'auth.token']);
  });

  it('requires an explicit environment token in non-interactive environments', async () => {
    const runWrangler = vi.fn(() => ({ status: 1, stderr: 'not logged in', stdout: '', data: '' }));
    await expect(
      resolvePlatformCloudflareCredential({
        interactive: false,
        runWrangler,
      }),
    ).rejects.toThrow('set CLOUDFLARE_API_TOKEN in CI');
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('does not accept a Wrangler API token from an implicit plaintext profile', async () => {
    await expect(
      readWranglerOAuthCredential(() => ({
        status: 0,
        stderr: '',
        stdout: '',
        data: { token: 'implicit-token', type: 'api_token' },
      })),
    ).resolves.toBeNull();
  });

  it('does not expose platform recovery or service secrets to Wrangler auth commands', () => {
    expect(
      cloudflareAuthEnvironment({
        CF_ACCESS_CLIENT_SECRET: 'access-secret',
        DATABASE_URL: 'postgres://secret',
        PATH: '/bin',
        VOID_PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret',
        VOID_PLATFORM_RECOVERY_KEY: 'recovery-secret',
      }),
    ).toEqual({ CLOUDFLARE_AUTH_USE_KEYRING: 'true', PATH: '/bin' });
  });
});

describe('platform authentication during input', () => {
  const success: CloudflareAuthRunResult = { status: 0, stderr: '', stdout: '', data: '' };
  const oauth = {
    ...success,
    stdout: '',
    data: { token: 'browser-token', type: 'oauth' },
  };

  it('shows input while the saved-login check is still pending', async () => {
    const check = deferred<typeof success>();
    const runWrangler = vi.fn().mockReturnValueOnce(check.promise).mockResolvedValue(oauth);
    const readInput = vi.fn(async () => 'team');
    const result = resolvePlatformCloudflareCredentialWithInput(readInput, {
      interactive: true,
      runWrangler,
    });
    expect(readInput).toHaveBeenCalledOnce();
    expect(runWrangler.mock.calls).toEqual([[{ type: 'auth.token' }, true]]);
    check.resolve(oauth);
    await expect(result).resolves.toEqual({
      input: 'team',
      credential: { source: 'oauth', token: 'browser-token' },
    });
    expect(runWrangler.mock.calls).toHaveLength(1);
  });

  it('waits for the name before opening browser login', async () => {
    const input = deferred<string>();
    const runWrangler = vi
      .fn()
      .mockResolvedValueOnce({ ...success, status: 1 })
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce(oauth);
    const result = resolvePlatformCloudflareCredentialWithInput(() => input.promise, {
      interactive: true,
      runWrangler,
    });
    await vi.waitFor(() => expect(runWrangler).toHaveBeenCalledTimes(1));
    input.resolve('team');
    await expect(result).resolves.toEqual({
      input: 'team',
      credential: { source: 'oauth', token: 'browser-token' },
    });
    expect(runWrangler.mock.calls.map(([args]) => args.type)).toEqual([
      'auth.token',
      'auth.login',
      'auth.token',
    ]);
  });

  it('does not start another auth command after input is cancelled', async () => {
    const check = deferred<typeof success>();
    const runWrangler = vi.fn().mockReturnValue(check.promise);
    await expect(
      resolvePlatformCloudflareCredentialWithInput(
        async () => {
          throw new Error('platform: Cancelled.');
        },
        { interactive: true, runWrangler },
      ),
    ).rejects.toThrow('Cancelled.');
    check.resolve(success);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runWrangler).toHaveBeenCalledOnce();
  });

  it('handles background auth failure without interrupting the name prompt', async () => {
    const input = deferred<string>();
    const runWrangler = vi.fn().mockRejectedValue(new Error('secure storage unavailable'));
    let settled = false;
    const result = resolvePlatformCloudflareCredentialWithInput(() => input.promise, {
      interactive: true,
      runWrangler,
    }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    input.resolve('team');
    await expect(result).rejects.toThrow('secure storage unavailable');
    expect(runWrangler).toHaveBeenCalledOnce();
  });

  it('still collects input when an environment credential skips authentication', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'ci-token';
    const runWrangler = vi.fn();
    await expect(
      resolvePlatformCloudflareCredentialWithInput(async () => 'team', {
        interactive: false,
        runWrangler,
      }),
    ).resolves.toEqual({ input: 'team', credential: { source: 'environment', token: 'ci-token' } });
    expect(runWrangler).not.toHaveBeenCalled();
  });
});
