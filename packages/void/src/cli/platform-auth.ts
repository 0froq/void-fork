import { runCloudflareAuthCommand, type CloudflareAuthRunner } from './cloudflare-auth.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

export type PlatformCloudflareCredential = Readonly<{
  source: 'environment' | 'oauth';
  token: string;
}>;

export type PlatformCloudflareAuthDependencies = Readonly<{
  interactive?: boolean;
  runWrangler?: CloudflareAuthRunner;
}>;

export function assertPlatformOperatorCredentialCanApplyPlan(
  credential: PlatformCloudflareCredential,
  plan: Pick<PlatformInstallPlan, 'actions'>,
): void {
  if (credential.source !== 'oauth') {
    return;
  }
  const createsZone = plan.actions.some(
    (action) => action.kind === 'zone' && action.action === 'create',
  );
  const writesDns = plan.actions.some(
    (action) => action.kind === 'dns-record' && action.action !== 'reuse',
  );
  if (!createsZone && !writesDns) {
    return;
  }
  const permissions = [
    ...(createsZone ? ['Account → Zone → Edit'] : []),
    ...(writesDns ? ['Zone → DNS → Edit'] : []),
  ];
  throw new Error(
    `platform: Cloudflare browser OAuth grants Zone Read and cannot apply the planned zone or DNS changes. Set CLOUDFLARE_API_TOKEN with ${permissions.join(' and ')}, scoped to the selected account and application zone, then rerun the command.`,
  );
}

export async function resolvePlatformCloudflareCredential(
  dependencies: PlatformCloudflareAuthDependencies = {},
): Promise<PlatformCloudflareCredential> {
  const { credential } = await resolvePlatformCloudflareCredentialWithInput(
    async () => undefined,
    dependencies,
  );
  return credential;
}

/** Check saved credentials during input, but never start browser login until it succeeds. */
export async function resolvePlatformCloudflareCredentialWithInput<T>(
  readInput: () => Promise<T>,
  dependencies: PlatformCloudflareAuthDependencies = {},
): Promise<Readonly<{ input: T; credential: PlatformCloudflareCredential }>> {
  const controller = new AbortController();
  const runner =
    dependencies.runWrangler ??
    ((args) => runCloudflareAuthCommand(process.cwd(), args, controller.signal));
  const runWrangler: CloudflareAuthRunner = (args, capture) => {
    controller.signal.throwIfAborted();
    return runner(args, capture);
  };
  // Handle failures immediately: a rejected background check must neither
  // interrupt the active prompt nor become an unhandled rejection.
  const pending = readExistingCredential(dependencies, runWrangler).then(
    (credential) => ({ ok: true as const, credential }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const cancel = () => controller.abort();
  const assertNotCancelled = () => {
    if (controller.signal.aborted) {
      throw new Error('platform: Cancelled.');
    }
  };
  try {
    const input = await readInput();
    // The prompt handles Ctrl+C while reading. Once it restores cooked input,
    // handle SIGINT ourselves so cancelling auth prints a useful message.
    process.once('SIGINT', cancel);
    const result = await pending;
    assertNotCancelled();
    if (!result.ok) {
      throw result.error;
    }
    if (result.credential) {
      return { input, credential: result.credential };
    }

    const login = await runWrangler({ type: 'auth.login' }, false);
    assertNotCancelled();
    if (login.status !== 0 || login.signal || login.error) {
      throw new Error('platform: Cloudflare browser login did not complete.');
    }
    const credential = await readWranglerOAuthCredential(runWrangler);
    assertNotCancelled();
    if (!credential) {
      throw new Error('platform: Cloudflare sign-in completed without a usable OAuth credential.');
    }
    return { input, credential };
  } finally {
    process.removeListener('SIGINT', cancel);
    // Cancelling the input also stops the child process. The background work
    // cannot launch a browser, even if it settles after this function exits.
    controller.abort();
  }
}

async function readExistingCredential(
  dependencies: PlatformCloudflareAuthDependencies,
  runWrangler: CloudflareAuthRunner,
): Promise<PlatformCloudflareCredential | null> {
  const environmentToken =
    process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim() || '';
  if (environmentToken) {
    return { source: 'environment', token: environmentToken };
  }

  if (!(dependencies.interactive ?? process.stdin.isTTY === true)) {
    throw new Error(
      'platform: Cloudflare authentication is required. Run `void cloudflare login` interactively, or set CLOUDFLARE_API_TOKEN in CI.',
    );
  }
  return await readWranglerOAuthCredential(runWrangler);
}

export async function readWranglerOAuthCredential(
  runWrangler: CloudflareAuthRunner = (args) => runCloudflareAuthCommand(process.cwd(), args),
): Promise<PlatformCloudflareCredential | null> {
  const result = await runWrangler({ type: 'auth.token' }, true);
  if (result.status !== 0 || result.signal || result.error) {
    return null;
  }
  try {
    const parsed = result.data as { token?: unknown; type?: unknown } | undefined;
    if (
      !parsed ||
      parsed.type !== 'oauth' ||
      typeof parsed.token !== 'string' ||
      !parsed.token.trim()
    ) {
      return null;
    }
    return { source: 'oauth', token: parsed.token.trim() };
  } catch {
    return null;
  }
}
