import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { confirm, isCancel, log } from '@clack/prompts';
import {
  assertExistingCloudflareConfig,
  readExistingCloudflareWorker,
  type ExistingCloudflareWorker,
  type CloudflareCommandRunner,
} from '@void/deploy-cloudflare';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { basename, join } from 'pathslash';
import type { RunDeployOptions } from './deploy.ts';
import { readDeploymentPlatform, writeDeploymentPlatform } from './project.ts';

const LINK_FILE = '.void/cloudflare-link.json';
export type CloudflareLink = { accountId: string; workerName: string };

/** A pending handoff survives a failed build, so retrying cannot provision replacements. */
export function readCloudflareLink(root: string): CloudflareLink | null {
  const path = join(root, LINK_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof value.accountId === 'string' &&
      value.accountId &&
      typeof value.workerName === 'string' &&
      value.workerName
    ) {
      return value;
    }
  } catch {
    /* Invalid state must never turn into an ordinary provisioning deploy. */
  }
  throw new Error(
    'The saved Cloudflare link is invalid. Restore .void/cloudflare-link.json before retrying.',
  );
}

export function saveCloudflareLink(root: string, link: CloudflareLink): void {
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(join(root, LINK_FILE), `${JSON.stringify(link)}\n`, { mode: 0o600 });
  writeDeploymentPlatform(root, 'cloudflare');
}

export function completeCloudflareLink(root: string): void {
  const path = join(root, LINK_FILE);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export async function prepareExistingCloudflareDeploy(options: {
  root: string;
  configPath: string;
  accountId: string;
  reuse?: boolean;
  runWrangler: CloudflareCommandRunner;
  readExistingWorker?: typeof readExistingCloudflareWorker;
}): Promise<ExistingCloudflareWorker | null> {
  const pending = readCloudflareLink(options.root);
  if (!options.reuse && !pending) {
    return null;
  }
  const text = readFileSync(options.configPath, 'utf8');
  const config = parse(text);
  if (
    typeof config?.name !== 'string' ||
    !config.name ||
    (pending && (pending.accountId !== options.accountId || pending.workerName !== config.name))
  ) {
    throw new Error(
      'The configured account or Worker differs from the existing Cloudflare link. Restore the original target before retrying.',
    );
  }
  const existing = await (options.readExistingWorker ?? readExistingCloudflareWorker)({
    runWrangler: options.runWrangler,
    configPath: options.configPath,
    workerName: config.name,
  });
  assertExistingCloudflareConfig(existing, config);
  let updated = text;
  const patch: Record<string, unknown> = { account_id: options.accountId, keep_vars: true };
  for (const key of ['compatibility_date', 'compatibility_flags', 'limits']) {
    if (config[key] === undefined && existing.runtime[key] !== undefined) {
      patch[key] = existing.runtime[key];
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    updated = applyEdits(
      updated,
      modify(updated, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  }
  // Save the guard before the destination so a retry cannot enter provisioning unguarded.
  saveCloudflareLink(options.root, { accountId: options.accountId, workerName: config.name });
  writeFileSync(options.configPath, updated);
  return existing;
}

/** Offer the existing destination before the legacy hosted-platform fallback. */
export async function maybeLinkCloudflareDeploy(
  root: string,
  options: RunDeployOptions = {},
  deps: { interactive?: boolean; confirm?: typeof confirm } = {},
): Promise<'existing' | 'cancelled' | null> {
  if (
    options.platform ||
    options.backend ||
    options.projectSlug ||
    process.env.VOID_PROJECT ||
    readDeploymentPlatform(root) !== null
  ) {
    return null;
  }
  const files = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].filter((name) =>
    existsSync(join(root, name)),
  );
  if (!files.length) {
    return null;
  }
  if (files.length > 1) {
    throw new Error(
      'Multiple Wrangler config files were found. Keep one root configuration before linking to Cloudflare.',
    );
  }
  const name = files[0]!;
  if (name.endsWith('.toml')) {
    throw new Error(
      'Found wrangler.toml. Direct Cloudflare deployment currently needs a root wrangler.jsonc or wrangler.json with the same settings. Convert the config before linking.',
    );
  }
  const errors: Array<ParseError> = [];
  const config = parse(readFileSync(join(root, name), 'utf8'), errors, {
    allowTrailingComma: true,
  });
  if (
    errors.length ||
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.name !== 'string' ||
    !config.name.trim()
  ) {
    throw new Error(
      `Set the existing Worker's name in a valid ${name} before linking to Cloudflare.`,
    );
  }
  if (!(deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    throw new Error(
      `Found ${name} without a deployment destination. Run void deploy interactively to link the existing Worker, or use void deploy --platform cloudflare with Cloudflare credentials in CI.`,
    );
  }
  log.info(`Found ${basename(name)} for Worker "${config.name}".`);
  const accepted = await (deps.confirm ?? confirm)({
    message: 'Link this project and deploy to Cloudflare using the existing Worker and resources?',
    initialValue: true,
  });
  return isCancel(accepted) || accepted !== true ? 'cancelled' : 'existing';
}
