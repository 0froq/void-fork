import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { log } from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  cloudflareAuthNeedsTerminal,
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
  runCloudflareAuthCommand,
} from '../../src/cli/cloudflare-auth.ts';
import { createDeployWranglerRunner, loadProvisionModule } from '../../src/cli/deploy.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock('../../src/cli/preset.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/preset.ts')>()),
  resolveWranglerArgv: () => [process.execPath, 'bundled-cli.js'],
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('cf browser login', () => {
  it.each([
    ['Cloudflare commands', () => createBundledCloudflareAuthRunner(process.cwd())],
    [
      'deploy',
      () => {
        const run = createDeployWranglerRunner(
          process.cwd(),
          'account-id',
          'https://api.cloudflare.com/client/v4',
        );
        return (args: ReadonlyArray<string>, capture: boolean) => run([...args], { capture });
      },
    ],
  ] as const)('%s shows the live login prompt', async (_, create) => {
    await loadProvisionModule();
    vi.spyOn(log, 'info').mockImplementation(() => {});
    let reads = 0;
    vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
      const action = args?.slice(1).join(' ');
      if (action === 'login') {
        expect(options?.stdio).toEqual(['inherit', 'inherit', 'ignore']);
      } else {
        expect(options?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      }
      const authenticated = action === 'whoami --json' && ++reads === 2;
      return {
        status: action === 'login' || authenticated ? 0 : 1,
        stdout: authenticated
          ? JSON.stringify({ loggedIn: true, accounts: [{ id: 'account-id' }] })
          : '',
        stderr: '',
        signal: null,
        pid: 1,
        output: [],
      };
    });
    await expect(
      ensureCloudflareAuthentication({ runWrangler: create(), interactive: true }),
    ).resolves.toMatchObject({
      accounts: [{ id: 'account-id' }],
    });
    expect(vi.mocked(spawnSync).mock.calls.map((call) => call[1]?.slice(1))).toEqual([
      ['whoami', '--json'],
      ['login'],
      ['whoami', '--json'],
    ]);
  });

  it('runs asynchronous login with inherited terminal and supports cancellation', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const controller = new AbortController();
    const result = runCloudflareAuthCommand(process.cwd(), ['login'], controller.signal);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['bundled-cli.js', 'login'],
      expect.objectContaining({
        stdio: ['inherit', 'inherit', 'ignore'],
        signal: controller.signal,
      }),
    );
    child.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('reports an asynchronous login spawn failure', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const result = runCloudflareAuthCommand(process.cwd(), ['login']);
    child.emit('error', new Error('spawn failed'));
    child.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: null, error: 'spawn failed' });
  });

  it('only streams browser login', () => {
    expect(cloudflareAuthNeedsTerminal(['login'])).toBe(true);
    expect(cloudflareAuthNeedsTerminal(['whoami', '--json'])).toBe(false);
    expect(cloudflareAuthNeedsTerminal(['auth', 'token', '--json'])).toBe(false);
  });
});
