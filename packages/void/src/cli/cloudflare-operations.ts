import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  encodeCloudflareVersionMessage,
  parseCloudflareVersionMessage,
  parseRootWranglerConfig,
  readBindingFieldPresence,
  readWranglerTopLevelString,
  resolveD1MigrateTarget,
  type CloudflareVersionMetadata,
} from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import { resolveWranglerArgv } from './preset.ts';
import {
  assertNoTransportRedirectInProjectDotenv,
  deleteEnvVarCaseAware,
  provisionEnv,
  resolvePinnedApiBaseUrl,
} from './provision.ts';
import {
  readWranglerCustomDomains,
  updateWranglerCustomDomain,
  type WranglerCustomDomain,
} from './wrangler.ts';

export type CloudflareOperationResult = {
  status: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  error?: string | null;
};

export type CloudflareOperationRunner = (
  args: Array<string>,
  options: { capture: boolean; input?: string },
) => CloudflareOperationResult | Promise<CloudflareOperationResult>;

export type CloudflareOperationContext = {
  accountId: string;
  configPath: string;
  workerName: string;
  runWrangler: CloudflareOperationRunner;
};

export type CloudflareWorkerVersion = {
  id: string;
  createdAt: string | null;
  message: string | null;
  metadata: CloudflareVersionMetadata | null;
};

export type CloudflareWorkerStatus = {
  workerName: string;
  activeVersionId: string | null;
  versions: Array<CloudflareWorkerVersion>;
};

export type CloudflareD1Context = {
  operation: CloudflareOperationContext;
  binding: string;
  migrateToken: string;
  migrationsDir: string;
  migrationsTable: string;
};

export function resolveCloudflareOperationContext(
  root: string,
  runner?: CloudflareOperationRunner,
): CloudflareOperationContext {
  const configPath = discoverRootWranglerConfig(root);
  if (!existsSync(configPath)) {
    throw new Error(`No Wrangler config found at "${configPath}". Run \`void init\` first.`);
  }
  assertNoOperationConfigOverride(root);
  assertNoTransportRedirectInProjectDotenv(root);
  const config = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(config, 'name');
  if (!workerName) {
    throw new Error(`Wrangler config "${configPath}" has no worker name. Run \`void init\` first.`);
  }
  const accountId =
    readWranglerTopLevelString(config, 'account_id') ??
    (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (!accountId) {
    throw new Error(
      'No Cloudflare account is pinned. Set account_id in wrangler.jsonc or CLOUDFLARE_ACCOUNT_ID.',
    );
  }
  const apiBaseUrl = resolvePinnedApiBaseUrl(
    process.env,
    readWranglerTopLevelString(config, 'compliance_region'),
  );
  return {
    accountId,
    configPath,
    workerName,
    runWrangler: runner ?? createCloudflareOperationRunner(root, accountId, apiBaseUrl),
  };
}

export async function listCloudflareSecrets(
  context: CloudflareOperationContext,
): Promise<Array<string>> {
  const result = await run(context, ['secret', 'list', ...targetArgs(context), '--format', 'json']);
  const parsed = parseJson(result.stdout, 'Cloudflare secret list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare secret list returned an unexpected response.');
  }
  return parsed
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }
      const value = entry as Record<string, unknown>;
      return typeof value.name === 'string' ? value.name : null;
    })
    .filter((name): name is string => name !== null)
    .sort();
}

export async function putCloudflareSecret(
  context: CloudflareOperationContext,
  name: string,
  value: string,
): Promise<void> {
  await run(context, ['secret', 'put', name, ...targetArgs(context)], { input: value });
}

export async function syncCloudflareSecrets(
  context: CloudflareOperationContext,
  secrets: ReadonlyArray<{ name: string; value: string }>,
): Promise<void> {
  const values = Object.fromEntries(secrets.map(({ name, value }) => [name, value]));
  await run(context, ['secret', 'bulk', ...targetArgs(context)], {
    input: `${JSON.stringify(values)}\n`,
  });
}

export async function deleteCloudflareSecret(
  context: CloudflareOperationContext,
  name: string,
): Promise<void> {
  await run(context, ['secret', 'delete', name, ...targetArgs(context)]);
}

export function resolveCloudflareD1Context(
  root: string,
  binding: string,
  runner?: CloudflareOperationRunner,
): CloudflareD1Context {
  const operation = resolveCloudflareOperationContext(root, runner);
  const config = parseRootWranglerConfig(operation.configPath);
  const target = resolveD1MigrateTarget(config, binding);
  if (!target.ok) {
    throw new Error(`Cannot resolve D1 binding ${binding}: ${target.reason}.`);
  }
  const migrationsDir = readBindingFieldPresence(config, 'd1_databases', binding, 'migrations_dir');
  const migrationsTable = readBindingFieldPresence(
    config,
    'd1_databases',
    binding,
    'migrations_table',
  );
  if (
    migrationsDir.present &&
    (typeof migrationsDir.value !== 'string' || migrationsDir.value.length === 0)
  ) {
    throw new Error(`D1 binding ${binding} has an invalid migrations_dir.`);
  }
  if (
    migrationsTable.present &&
    (typeof migrationsTable.value !== 'string' || migrationsTable.value.length === 0)
  ) {
    throw new Error(`D1 binding ${binding} has an invalid migrations_table.`);
  }
  return {
    operation,
    binding,
    migrateToken: target.token,
    migrationsDir: migrationsDir.present ? (migrationsDir.value as string) : 'db/migrations',
    migrationsTable: migrationsTable.present ? (migrationsTable.value as string) : 'd1_migrations',
  };
}

export async function executeCloudflareD1Sql(
  context: CloudflareD1Context,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await run(context.operation, [
    'd1',
    'execute',
    context.migrateToken,
    '--remote',
    '--command',
    sql,
    '--json',
    '-c',
    context.operation.configPath,
    '--env=',
  ]);
  const parsed = parseJson(result.stdout, 'Cloudflare D1 execute');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare D1 execute returned an unexpected response.');
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Cloudflare D1 execute returned a malformed result.');
    }
    const resultRows = (item as Record<string, unknown>).results;
    if (!Array.isArray(resultRows)) {
      continue;
    }
    for (const row of resultRows) {
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        rows.push(row as Record<string, unknown>);
      }
    }
  }
  return rows;
}

export async function readCloudflareD1Migrations(
  context: CloudflareD1Context,
): Promise<Array<string>> {
  const table = context.migrationsTable.replace(/"/g, '""');
  try {
    const rows = await executeCloudflareD1Sql(context, `SELECT name FROM "${table}" ORDER BY name`);
    return rows
      .map((row) => (typeof row.name === 'string' ? row.name : null))
      .filter((name): name is string => name !== null);
  } catch (error) {
    if (/no such table/i.test(errorMessage(error))) {
      return [];
    }
    throw error;
  }
}

export async function applyCloudflareD1Migrations(context: CloudflareD1Context): Promise<void> {
  await run(
    context.operation,
    [
      'd1',
      'migrations',
      'apply',
      context.migrateToken,
      '--remote',
      '-c',
      context.operation.configPath,
      '--env=',
    ],
    { capture: false },
  );
}

export async function readCloudflareWorkerStatus(
  context: CloudflareOperationContext,
): Promise<CloudflareWorkerStatus> {
  const [deployment, versions] = await Promise.all([
    run(context, ['deployments', 'status', ...targetArgs(context), '--json']),
    run(context, ['versions', 'list', ...targetArgs(context), '--json']),
  ]);
  return {
    workerName: context.workerName,
    activeVersionId: parseActiveVersionId(deployment.stdout),
    versions: parseCloudflareVersions(versions.stdout),
  };
}

export function parseCloudflareVersions(value: string): Array<CloudflareWorkerVersion> {
  const parsed = parseJson(value, 'Cloudflare version list');
  if (!Array.isArray(parsed)) {
    throw new Error('Cloudflare version list returned an unexpected response.');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') {
      throw new Error(`Cloudflare version list entry ${index + 1} is malformed.`);
    }
    const metadata =
      typeof entry.metadata === 'object' && entry.metadata !== null
        ? (entry.metadata as Record<string, unknown>)
        : undefined;
    const annotations =
      typeof entry.annotations === 'object' && entry.annotations !== null
        ? (entry.annotations as Record<string, unknown>)
        : undefined;
    const message =
      typeof annotations?.['workers/message'] === 'string' ? annotations['workers/message'] : null;
    return {
      id: entry.id,
      createdAt: typeof metadata?.created_on === 'string' ? metadata.created_on : null,
      message,
      metadata: parseCloudflareVersionMessage(message),
    };
  });
}

export function parseActiveVersionId(value: string): string | null {
  const parsed = parseJson(value, 'Cloudflare deployment status');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Cloudflare deployment status returned an unexpected response.');
  }
  const deployment = parsed as Record<string, unknown>;
  if (!Array.isArray(deployment.versions)) {
    throw new Error('Cloudflare deployment status returned an unexpected response.');
  }
  const versions = deployment.versions;
  const active =
    versions.find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        Number((entry as Record<string, unknown>).percentage) === 100,
    ) ?? versions[0];
  if (active === undefined) {
    return null;
  }
  if (
    typeof active !== 'object' ||
    active === null ||
    typeof (active as Record<string, unknown>).version_id !== 'string'
  ) {
    throw new Error('Cloudflare deployment status has a malformed active version.');
  }
  return (active as Record<string, string>).version_id;
}

export async function activateCloudflareExistingVersion(
  context: CloudflareOperationContext,
  target: CloudflareWorkerVersion,
): Promise<void> {
  const message = target.metadata
    ? encodeCloudflareVersionMessage(target.metadata.migrations)
    : `Void rollback to ${target.id}.`;
  await run(
    context,
    [
      'versions',
      'deploy',
      `${target.id}@100`,
      ...targetArgs(context),
      '--message',
      message,
      '--yes',
    ],
    { capture: false },
  );
}

export async function tailCloudflareWorker(
  context: CloudflareOperationContext,
  options: { filter?: string; versionId?: string; status?: 'error' },
): Promise<void> {
  const args = [
    'tail',
    context.workerName,
    '-c',
    context.configPath,
    '--env=',
    '--format',
    'pretty',
  ];
  if (options.filter) {
    args.push('--search', options.filter);
  }
  if (options.versionId) {
    args.push('--version-id', options.versionId);
  }
  if (options.status) {
    args.push('--status', options.status);
  }
  await run(context, args, { capture: false });
}

export function listCloudflareDomains(root: string): Array<WranglerCustomDomain> {
  return readWranglerCustomDomains(root).domains;
}

export async function changeCloudflareDomain(
  root: string,
  hostname: string,
  action: 'add' | 'delete',
  runner?: CloudflareOperationRunner,
): Promise<{ modified: boolean; domains: Array<WranglerCustomDomain> }> {
  const context = resolveCloudflareOperationContext(root, runner);
  const before = readWranglerCustomDomains(root);
  const original = readFileSync(before.configPath, 'utf-8');
  const update = updateWranglerCustomDomain(root, hostname, action);
  if (!update.modified) {
    return update;
  }
  try {
    await run(context, ['triggers', 'deploy', ...targetArgs(context)], { capture: false });
  } catch (error) {
    writeFileSync(before.configPath, original);
    throw new Error(
      `Cloudflare rejected the domain trigger update; the local Wrangler config was restored. ${errorMessage(error)}`,
    );
  }
  return update;
}

function targetArgs(context: CloudflareOperationContext): Array<string> {
  return ['-c', context.configPath, '--env=', '--name', context.workerName];
}

async function run(
  context: CloudflareOperationContext,
  args: Array<string>,
  options?: { capture?: boolean; input?: string },
): Promise<CloudflareOperationResult> {
  const result = await Promise.resolve(
    context.runWrangler(args, {
      capture: options?.capture ?? true,
      input: options?.input,
    }),
  );
  if (
    result.status !== 0 ||
    result.signal != null ||
    (result.error !== undefined && result.error !== null && result.error !== '')
  ) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error || 'unknown error';
    throw new Error(
      `Wrangler failed (${args.slice(0, 2).join(' ')}, exit ${result.status}): ${detail}`,
    );
  }
  return result;
}

function createCloudflareOperationRunner(
  root: string,
  accountId: string,
  apiBaseUrl: string,
): CloudflareOperationRunner {
  const [command, ...prefix] = resolveWranglerArgv(root);
  return (args, options) => {
    const env = provisionEnv({ accountId, apiBaseUrl });
    deleteEnvVarCaseAware(env, 'WRANGLER_CI_OVERRIDE_NAME');
    const result = spawnSync(command, [...prefix, ...args], {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      encoding: 'utf-8',
      input: options.input,
      stdio:
        options.input !== undefined
          ? ['pipe', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit']
          : options.capture
            ? ['ignore', 'pipe', 'pipe']
            : 'inherit',
    });
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      signal: result.signal ?? null,
      error: result.error?.message ?? null,
    };
  };
}

function discoverRootWranglerConfig(root: string): string {
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const path = join(root, name);
    if (existsSync(path)) {
      return path;
    }
  }
  return join(root, 'wrangler.jsonc');
}

function assertNoOperationConfigOverride(root: string): void {
  if (process.env.CLOUDFLARE_ENV?.trim()) {
    throw new Error(
      'CLOUDFLARE_ENV is set. Void Cloudflare operations target the top-level config only.',
    );
  }
  if (process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH?.trim()) {
    throw new Error(
      'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH is set. Void Cloudflare operations use the root Wrangler config only.',
    );
  }
  for (const file of ['.env', '.env.local', '.env.', '.env..local']) {
    const keys = scanWranglerDotenvKeys(join(root, file));
    const containsOverride =
      process.platform === 'win32'
        ? [...keys].some((key) => key.toLowerCase() === 'wrangler_ci_override_name')
        : keys.has('WRANGLER_CI_OVERRIDE_NAME');
    if (containsOverride) {
      throw new Error(
        `Project file "${file}" sets WRANGLER_CI_OVERRIDE_NAME, which can replace the pinned Worker name. Remove it before running this command.`,
      );
    }
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
