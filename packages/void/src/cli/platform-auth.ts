import { spawnSync } from 'node:child_process';
import { confirm, isCancel } from '@clack/prompts';
import { resolveWranglerArgv } from './preset.ts';

export type PlatformCloudflareCredential = Readonly<{
  source: 'environment' | 'oauth';
  token: string;
}>;

type WranglerAuthResult = Readonly<{
  status: number | null;
  stderr: string;
  stdout: string;
}>;

export type PlatformCloudflareAuthDependencies = Readonly<{
  confirmLogin?: () => Promise<boolean>;
  interactive?: boolean;
  runWrangler?: (args: ReadonlyArray<string>, capture: boolean) => WranglerAuthResult;
}>;

export async function resolvePlatformCloudflareCredential(
  dependencies: PlatformCloudflareAuthDependencies = {},
): Promise<PlatformCloudflareCredential> {
  const environmentToken =
    process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim() || '';
  if (environmentToken) {
    return { source: 'environment', token: environmentToken };
  }

  const runWrangler = dependencies.runWrangler ?? defaultWranglerAuthRunner;
  if (!(dependencies.interactive ?? process.stdin.isTTY === true)) {
    throw new Error(
      'platform: Cloudflare authentication is required. Run `wrangler login` with keyring storage, or set CLOUDFLARE_API_TOKEN in CI.',
    );
  }
  const keyring = runWrangler(['auth', 'keyring', 'enable'], true);
  if (keyring.status !== 0) {
    throw new Error(
      'platform: Could not enable Wrangler keyring storage. Refusing to use a plaintext Cloudflare OAuth credential.',
    );
  }
  const existing = readWranglerOAuthCredential(runWrangler);
  if (existing) {
    return existing;
  }

  const approved = dependencies.confirmLogin
    ? await dependencies.confirmLogin()
    : await confirmCloudflareLogin();
  if (!approved) {
    throw new Error('platform: Cloudflare login was cancelled.');
  }

  const login = runWrangler(['login'], false);
  if (login.status !== 0) {
    throw new Error('platform: Cloudflare browser login did not complete.');
  }
  const credential = readWranglerOAuthCredential(runWrangler);
  if (!credential) {
    throw new Error('platform: Wrangler login completed without a usable OAuth credential.');
  }
  return credential;
}

export function readWranglerOAuthCredential(
  runWrangler: (
    args: ReadonlyArray<string>,
    capture: boolean,
  ) => WranglerAuthResult = defaultWranglerAuthRunner,
): PlatformCloudflareCredential | null {
  const result = runWrangler(['auth', 'token', '--json'], true);
  if (result.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as { token?: unknown; type?: unknown };
    if (parsed.type !== 'oauth' || typeof parsed.token !== 'string' || !parsed.token.trim()) {
      return null;
    }
    return { source: 'oauth', token: parsed.token.trim() };
  } catch {
    return null;
  }
}

async function confirmCloudflareLogin(): Promise<boolean> {
  const result = await confirm({
    message: 'Sign in to Cloudflare in your browser?',
    initialValue: true,
  });
  if (isCancel(result) || typeof result === 'symbol') {
    return false;
  }
  return result;
}

function defaultWranglerAuthRunner(
  args: ReadonlyArray<string>,
  capture: boolean,
): WranglerAuthResult {
  const [command, ...prefix] = resolveWranglerArgv(process.cwd());
  const result = spawnSync(command!, [...prefix, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: wranglerAuthEnvironment(),
    maxBuffer: 10 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 10 * 60 * 1000,
  });
  return {
    status: result.status,
    stderr: capture ? result.stderr || '' : '',
    stdout: capture ? result.stdout || '' : '',
  };
}

export function wranglerAuthEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      /^VOID_PLATFORM_/i.test(key) ||
      /^(?:DATABASE_URL|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET|CF_ACCESS_TOKEN)$/i.test(key)
    ) {
      delete env[key];
    }
  }
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
  return env;
}
