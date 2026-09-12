import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractWorkersDevSubdomain, normalizeWorkersDevSubdomain } from '@void/deploy-cloudflare';
import { dirname, join } from 'pathslash';

const STATE_FILE = join('.void', 'cloudflare.json');

type CloudflareLocalState = {
  workersDevSubdomain?: unknown;
};

/** Resolve the account subdomain without exposing Cloudflare credentials to project code. */
export function resolveCloudflareWorkersDevSubdomain(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = env.CLOUDFLARE_WORKERS_SUBDOMAIN;
  if (configured !== undefined && configured.trim().length > 0) {
    const normalized = normalizeWorkersDevSubdomain(configured);
    if (!normalized) {
      throw new Error(
        'deploy: CLOUDFLARE_WORKERS_SUBDOMAIN must be the account subdomain, for example "my-team" or "my-team.workers.dev".',
      );
    }
    return normalized;
  }

  const cached = readCloudflareLocalState(root).workersDevSubdomain;
  return typeof cached === 'string' ? normalizeWorkersDevSubdomain(cached) : undefined;
}

/** Cache a Wrangler-reported account subdomain for later no-preview version probes. */
export function rememberCloudflareWorkersDevSubdomain(root: string, url: string): boolean {
  const workersDevSubdomain = extractWorkersDevSubdomain(url);
  if (!workersDevSubdomain) {
    return false;
  }
  const current = readCloudflareLocalState(root);
  if (current.workersDevSubdomain === workersDevSubdomain) {
    return false;
  }
  const filePath = join(root, STATE_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ ...current, workersDevSubdomain }, null, 2) + '\n');
  return true;
}

function readCloudflareLocalState(root: string): CloudflareLocalState {
  const filePath = join(root, STATE_FILE);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as CloudflareLocalState)
      : {};
  } catch {
    return {};
  }
}
