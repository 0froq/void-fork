import { execFile, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { log } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  cloudflareKeyringNeedsTerminal,
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
  runCloudflareAuthCommand,
} from '../../src/cli/cloudflare-auth.ts';
import { createDeployWranglerRunner, loadProvisionModule } from '../../src/cli/deploy.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock('../../src/cli/preset.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/preset.ts')>()),
  resolveWranglerArgv: () => [process.execPath, 'bundled-cli.js'],
}));

const keyringArgs = ['auth', 'keyring', 'enable'];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

beforeEach(async () => {
  await loadProvisionModule();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stdout, stdoutTty],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(stream, 'isTTY', descriptor);
    } else {
      Reflect.deleteProperty(stream, 'isTTY');
    }
  }
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('Windows keyring bootstrap', () => {
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
  ] as const)(
    '%s installs the backend before resuming captured authentication',
    async (_, create) => {
      let installed = false;
      vi.spyOn(log, 'info').mockImplementation(() => {});
      vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
        // Model Wrangler's first-use gate: a missing Windows backend cannot be
        // installed from piped stdio. All credentials here are synthetic.
        if (args?.includes('keyring')) {
          installed =
            JSON.stringify(options?.stdio) === JSON.stringify(['inherit', 'inherit', 'ignore']);
          expect(options?.env?.WRANGLER_LOG).toBe('none');
        } else {
          expect(options?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
        }
        expect(options?.env?.CLOUDFLARE_AUTH_USE_KEYRING).toBe('true');
        return {
          status: installed ? 0 : 1,
          stdout: installed
            ? JSON.stringify({
                loggedIn: true,
                authType: 'OAuth Token',
                accounts: [{ id: 'account-id' }],
              })
            : '',
          stderr: '',
          signal: null,
          pid: 1,
          output: [],
        };
      });
      const runWrangler = create();
      await expect(
        ensureCloudflareAuthentication({ runWrangler, interactive: true }),
      ).resolves.toMatchObject({
        accounts: [{ id: 'account-id' }],
      });
      expect(vi.mocked(spawnSync).mock.calls.map((call) => call[1]?.slice(1))).toEqual([
        ['whoami', '--json'],
        keyringArgs,
        ['login', '--use-keyring'],
        ['whoami', '--json'],
      ]);
      expect(installed).toBe(true);
    },
  );

  it('keeps asynchronous setup cancellable without reading terminal input', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const controller = new AbortController();
    const result = runCloudflareAuthCommand(process.cwd(), keyringArgs, controller.signal);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['bundled-cli.js', ...keyringArgs],
      expect.objectContaining({
        stdio: ['inherit', 'inherit', 'ignore'],
        signal: controller.signal,
        env: expect.objectContaining({ WRANGLER_LOG: 'none', CLOUDFLARE_AUTH_USE_KEYRING: 'true' }),
      }),
    );
    child.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports asynchronous spawn failure as a failed setup', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const result = runCloudflareAuthCommand(process.cwd(), keyringArgs);
    child.emit('error', new Error('spawn failed'));
    child.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: null, error: 'spawn failed' });
  });

  it.each([
    ['auth', 'token', '--json'],
    ['whoami', '--json'],
    ['login', '--use-keyring'],
    ['logout'],
    ['auth', 'keyring', 'disable'],
  ])('does not inherit the terminal for %j', (...args) => {
    expect(cloudflareKeyringNeedsTerminal(args)).toBe(false);
  });

  it.each(['stdin', 'stdout'] as const)('does not bootstrap from a redirected %s', (stream) => {
    Object.defineProperty(process[stream], 'isTTY', { value: false });
    expect(cloudflareKeyringNeedsTerminal(keyringArgs)).toBe(false);
  });

  it.each(['darwin', 'linux'])('keeps %s setup captured', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    expect(cloudflareKeyringNeedsTerminal(keyringArgs)).toBe(false);
  });
});
