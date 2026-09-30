import { execFile, spawn, spawnSync } from 'node:child_process';
import { resolveWranglerArgv } from './preset.ts';

export type CloudflareAccount = Readonly<{
  id: string;
  name: string;
}>;

export type CloudflareAuthRunResult = Readonly<{
  status: number | null;
  stderr: string;
  stdout: string;
  signal?: NodeJS.Signals | null;
  error?: string | null;
}>;

export type CloudflareAuthRunner = (
  args: ReadonlyArray<string>,
  capture: boolean,
) => CloudflareAuthRunResult | Promise<CloudflareAuthRunResult>;

export type CloudflareAuthSession = Readonly<{
  accounts: ReadonlyArray<CloudflareAccount>;
  email?: string;
  authType?: string;
}>;

export type EnsureCloudflareAuthenticationOptions = Readonly<{
  /**
   * Treat an explicit API token as sufficient for a pinned, non-discovery operation.
   * The operation itself remains the authoritative permission and validity check.
   */
  acceptApiToken?: boolean;
  /** Explicit login must authenticate again, even when an existing session works. */
  forceLogin?: boolean;
  beforeRun?: () => boolean;
  interactive?: boolean;
  /** Require whoami JSON to contain at least one account (account onboarding). */
  requireAccounts?: boolean;
  runWrangler: CloudflareAuthRunner;
  whoamiArgs?: ReadonlyArray<string>;
}>;

export class CloudflareAuthenticationError extends Error {
  override name = 'CloudflareAuthenticationError';
  readonly reason: 'login' | 'not-authenticated' | 'uploader-changed' | 'environment-credentials';

  constructor(message: string, reason: CloudflareAuthenticationError['reason']) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Authenticate with Cloudflare through Void's bundled deployment tooling.
 *
 * The caller owns the runner so deploy can retain its pinned account, API base,
 * config, and uploader-integrity boundary. Interactive sessions recover from an
 * expired or missing OAuth session in-process; CI remains token-only.
 */
export async function ensureCloudflareAuthentication(
  options: EnsureCloudflareAuthenticationOptions,
): Promise<CloudflareAuthSession> {
  if (options.forceLogin) {
    const overrides = cloudflareCredentialOverrides();
    if (overrides.length > 0) {
      throw new CloudflareAuthenticationError(
        `Cloudflare browser login cannot replace credentials supplied by ${overrides.join(', ')}. Remove these overrides from this shell and rerun \`void cloudflare login\`.`,
        'environment-credentials',
      );
    }
  }
  if (
    options.acceptApiToken &&
    !options.requireAccounts &&
    (process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim())
  ) {
    return { accounts: [] };
  }
  const run = async (
    args: ReadonlyArray<string>,
    capture: boolean,
  ): Promise<CloudflareAuthRunResult> => {
    if (options.beforeRun && !options.beforeRun()) {
      throw new CloudflareAuthenticationError('', 'uploader-changed');
    }
    return await options.runWrangler(args, capture);
  };
  const whoamiArgs = ['whoami', '--json', ...(options.whoamiArgs ?? [])];
  const readSession = async (): Promise<CloudflareAuthSession | null> => {
    const result = await run(whoamiArgs, true);
    if (!isCleanExit(result)) {
      return null;
    }
    const session = parseCloudflareAuthSession(result.stdout);
    if (options.requireAccounts) {
      return session && session.accounts.length > 0 ? session : null;
    }
    // Credentialed deploy commands only need Wrangler's clean exit. Keeping
    // account parsing optional also tolerates older Wrangler JSON shapes.
    return session ?? (options.forceLogin ? null : { accounts: [] });
  };

  const existing = options.forceLogin ? null : await readSession();
  if (existing) {
    return existing;
  }

  const interactive = options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new CloudflareAuthenticationError(
      'Cloudflare authentication is required. Set CLOUDFLARE_API_TOKEN in CI, or run `void cloudflare login` in an interactive terminal.',
      'not-authenticated',
    );
  }

  const login = await run(['login'], false);
  if (!isCleanExit(login)) {
    throw new CloudflareAuthenticationError(
      'Cloudflare browser sign-in did not complete. Run `void cloudflare login` to try again.',
      'login',
    );
  }

  const authenticated = await readSession();
  if (!authenticated) {
    throw new CloudflareAuthenticationError(
      'Cloudflare sign-in completed without a usable session. Run `void cloudflare login` to try again.',
      'not-authenticated',
    );
  }
  return authenticated;
}

/** Credential names only: never include their values in diagnostics. */
export function cloudflareCredentialOverrides(
  source: NodeJS.ProcessEnv = process.env,
): Array<string> {
  const tokens = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'].filter((key) => Boolean(source[key]));
  const key = ['CLOUDFLARE_API_KEY', 'CF_API_KEY'].find((key) => Boolean(source[key]));
  const email = ['CLOUDFLARE_EMAIL', 'CF_EMAIL'].find((key) => Boolean(source[key]));
  return [...tokens, ...(key && email ? [key, email] : [])];
}

export function parseCloudflareAuthSession(stdout: string): CloudflareAuthSession | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.loggedIn !== true || !Array.isArray(record.accounts)) {
    return null;
  }

  const accounts: Array<CloudflareAccount> = [];
  for (const account of record.accounts) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      continue;
    }
    const item = account as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      continue;
    }
    accounts.push({
      id: item.id,
      name:
        typeof item.name === 'string' && item.name.length > 0 ? item.name : 'Cloudflare account',
    });
  }
  return {
    accounts,
    ...(typeof record.email === 'string' && record.email ? { email: record.email } : {}),
    ...(typeof record.authType === 'string' && record.authType
      ? { authType: record.authType }
      : {}),
  };
}

export function createBundledCloudflareAuthRunner(root: string): CloudflareAuthRunner {
  const [command, ...prefix] = resolveWranglerArgv(root);
  return (args, capture) => {
    const env = cloudflareAuthCommandEnvironment(args);
    const result = spawnSync(command!, [...prefix, ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      stdio: cloudflareAuthNeedsTerminal(args)
        ? 'inherit'
        : capture
          ? ['ignore', 'pipe', 'pipe']
          : 'inherit',
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    });
    return {
      status: result.status,
      stderr: capture ? result.stderr || '' : '',
      stdout: capture ? result.stdout || '' : '',
      signal: result.signal,
      error: result.error?.message,
    };
  };
}

/** Run a captured auth command without blocking terminal input or exposing credentials. */
export function runCloudflareAuthCommand(
  root: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<CloudflareAuthRunResult> {
  const [command, ...prefix] = resolveWranglerArgv(root);
  if (cloudflareAuthNeedsTerminal(args)) {
    // cf can prompt or print a device code while the browser login is active.
    return new Promise((resolve) => {
      const child = spawn(command!, [...prefix, ...args], {
        cwd: root,
        env: cloudflareAuthCommandEnvironment(args),
        shell: false,
        signal,
        stdio: 'inherit',
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      });
      child.once('error', (error) => {
        resolve({ status: null, stdout: '', stderr: '', error: error.message });
      });
      child.once('close', (status, signal) => {
        resolve({ status, signal, stdout: '', stderr: '' });
      });
    });
  }
  return new Promise((resolve) => {
    const child = execFile(
      command!,
      [...prefix, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: cloudflareAuthCommandEnvironment(args),
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        signal,
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stderr,
          stdout,
          signal: error?.signal,
          error: error?.message,
        });
      },
    );
    child.stdin?.end();
  });
}

export function cloudflareAuthCommandEnvironment(
  args: ReadonlyArray<string>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  void args;
  return cloudflareAuthEnvironment(source);
}

/** Browser login must display cf's prompts before it completes. */
export function cloudflareAuthNeedsTerminal(args: ReadonlyArray<string>): boolean {
  return args[0] === 'login';
}

export function cloudflareAuthEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  const scrubbedWranglerKeys = new Set([
    'WRANGLER_OUTPUT_FILE_DIRECTORY',
    'WRANGLER_OUTPUT_FILE_PATH',
    'WRANGLER_LOG_SANITIZE',
  ]);
  for (const key of Object.keys(env)) {
    if (
      /^VOID_PLATFORM_/i.test(key) ||
      /^(?:DATABASE_URL|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET|CF_ACCESS_TOKEN|VOID_ACCESS_CREDENTIALS|VOID_ACCESS_ORIGIN)$/i.test(
        key,
      ) ||
      scrubbedWranglerKeys.has(key.toUpperCase())
    ) {
      delete env[key];
    }
    if (key.toUpperCase() === 'CLOUDFLARE_AUTH_USE_KEYRING') {
      delete env[key];
    }
  }
  // Deploy uses the encrypted cf store. Login and status must read that same
  // store: cf migrates plaintext credentials into it and removes the old file.
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
  return env;
}

function isCleanExit(result: CloudflareAuthRunResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}
