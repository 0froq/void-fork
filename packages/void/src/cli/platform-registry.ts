import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import {
  parsePlatformInstallationManifest,
  type PlatformInstallationManifest,
} from '@void/platform';
import { join } from 'pathslash';

export const PLATFORM_REGISTRY_SCHEMA_VERSION = 1 as const;

export type PlatformConnection = Readonly<{
  accountId: string | null;
  apiUrl: string;
  applicationDomain: string | null;
  displayName: string;
  id: string;
  installationId: string | null;
  kind: 'connected' | 'installed';
  lastUsedAt: string;
  proxyUrl: string | null;
}>;

type PlatformConnectionRegistry = Readonly<{
  activeConnectionId: string | null;
  connections: ReadonlyArray<PlatformConnection>;
  schemaVersion: typeof PLATFORM_REGISTRY_SCHEMA_VERSION;
}>;

const DEFAULT_REGISTRY: PlatformConnectionRegistry = {
  activeConnectionId: null,
  connections: [],
  schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
};

export function platformRegistryDirectory(): string {
  return process.env.VOID_PLATFORM_REGISTRY_DIR ?? join(homedir(), '.void', 'platforms');
}

export function normalizePlatformApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`platform: Invalid platform URL ${JSON.stringify(value)}.`);
  }
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('platform: Platform URLs must use HTTPS and must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new Error('platform: Platform URLs must not contain query parameters or fragments.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('platform: Platform URLs must not contain a path.');
  }
  return url.origin;
}

export function platformConnectionId(apiUrl: string): string {
  return createHash('sha256').update(normalizePlatformApiUrl(apiUrl)).digest('hex').slice(0, 20);
}

export function platformCredentialAccount(apiUrl: string): string {
  return `platform:${createHash('sha256').update(normalizePlatformApiUrl(apiUrl)).digest('hex')}`;
}

function parseConnection(value: unknown): PlatformConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('platform: Invalid connection entry in the local registry.');
  }
  const entry = value as Record<string, unknown>;
  const apiUrl = normalizePlatformApiUrl(String(entry.apiUrl ?? ''));
  const id = String(entry.id ?? '');
  if (id !== platformConnectionId(apiUrl)) {
    throw new Error('platform: Connection id does not match its API URL.');
  }
  if (entry.kind !== 'connected' && entry.kind !== 'installed') {
    throw new Error('platform: Invalid connection kind in the local registry.');
  }
  const lastUsedAt = String(entry.lastUsedAt ?? '');
  if (!Number.isFinite(Date.parse(lastUsedAt))) {
    throw new Error('platform: Invalid connection timestamp in the local registry.');
  }
  const optionalString = (input: unknown): string | null =>
    typeof input === 'string' && input !== '' ? input : null;
  const proxyUrl =
    optionalString(entry.proxyUrl) ??
    (apiUrl === 'https://api.void.cloud'
      ? 'https://proxy.void.cloud'
      : apiUrl === 'https://api.staging.void.cloud'
        ? 'https://proxy.staging.void.cloud'
        : null);
  return {
    accountId: optionalString(entry.accountId),
    apiUrl,
    applicationDomain: optionalString(entry.applicationDomain),
    displayName:
      typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim()
        : new URL(apiUrl).hostname,
    id,
    installationId: optionalString(entry.installationId),
    kind: entry.kind,
    lastUsedAt,
    proxyUrl: proxyUrl === null ? null : normalizePlatformApiUrl(proxyUrl),
  };
}

function readRegistry(directory: string): PlatformConnectionRegistry {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'registry.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('registry must be an object');
    }
    const value = parsed as Record<string, unknown>;
    if (
      value.schemaVersion !== PLATFORM_REGISTRY_SCHEMA_VERSION ||
      !Array.isArray(value.connections)
    ) {
      throw new Error('unsupported schema');
    }
    const connections = value.connections.map(parseConnection);
    const activeConnectionId =
      typeof value.activeConnectionId === 'string' &&
      connections.some((connection) => connection.id === value.activeConnectionId)
        ? value.activeConnectionId
        : null;
    return { activeConnectionId, connections, schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_REGISTRY;
    }
    throw new Error(
      `platform: Could not read ${join(directory, 'registry.json')}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function withRegistryLock<T>(directory: string, operation: () => T): T {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.registry.lock');
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age < 10 * 60 * 1000) {
      throw new Error('platform: Another process is updating the platform registry.');
    }
    rmSync(lockPath, { force: true });
    descriptor = openSync(lockPath, 'wx', 0o600);
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function acquirePlatformLifecycleLock(
  accountId: string,
  installationSlug: string,
  directory: string = platformRegistryDirectory(),
): () => void {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(installationSlug)) {
    throw new Error('platform: Invalid lifecycle lock identity.');
  }
  const lockDirectory = join(directory, 'locks');
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(lockDirectory, `${accountId}-${installationSlug}.lock`);
  const acquire = (): number => {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ host: hostname(), pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
          host?: unknown;
          pid?: unknown;
          startedAt?: unknown;
        };
        if (owner.host === hostname() && typeof owner.pid === 'number') {
          try {
            process.kill(owner.pid, 0);
          } catch (ownerError) {
            stale = (ownerError as NodeJS.ErrnoException).code === 'ESRCH';
          }
        } else {
          const startedAt = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : NaN;
          stale = Number.isFinite(startedAt) && Date.now() - startedAt > 2 * 60 * 60 * 1000;
        }
      } catch {
        stale = Date.now() - statSync(lockPath).mtimeMs > 2 * 60 * 60 * 1000;
      }
      if (!stale) {
        throw new Error(
          `platform: Another lifecycle operation is active for ${installationSlug} in account ${accountId}.`,
        );
      }
      rmSync(lockPath, { force: true });
      return acquire();
    }
  };
  const descriptor = acquire();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  };
}

export function listPlatformConnections(
  directory: string = platformRegistryDirectory(),
): ReadonlyArray<PlatformConnection> {
  return readRegistry(directory).connections;
}

export function getActivePlatformConnection(
  directory: string = platformRegistryDirectory(),
): PlatformConnection | null {
  const registry = readRegistry(directory);
  return (
    registry.connections.find((connection) => connection.id === registry.activeConnectionId) ??
    (registry.connections.length === 1 ? registry.connections[0]! : null)
  );
}

export function savePlatformConnection(
  input: Omit<PlatformConnection, 'id' | 'lastUsedAt'> & { lastUsedAt?: string },
  directory: string = platformRegistryDirectory(),
): PlatformConnection {
  const apiUrl = normalizePlatformApiUrl(input.apiUrl);
  const id = platformConnectionId(apiUrl);
  const lastUsedAt = input.lastUsedAt ?? new Date().toISOString();
  const connection = parseConnection({ ...input, apiUrl, id, lastUsedAt });
  return withRegistryLock(directory, () => {
    const current = readRegistry(directory);
    const connections = current.connections.filter((entry) => entry.id !== id);
    connections.push(connection);
    connections.sort((left, right) => left.displayName.localeCompare(right.displayName));
    writeJsonAtomically(join(directory, 'registry.json'), {
      activeConnectionId: id,
      connections,
      schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
    });
    return connection;
  });
}

export function selectPlatformConnection(
  selector: string,
  directory: string = platformRegistryDirectory(),
): PlatformConnection {
  return withRegistryLock(directory, () => {
    const current = readRegistry(directory);
    const normalizedUrl = (() => {
      try {
        return normalizePlatformApiUrl(selector);
      } catch {
        return null;
      }
    })();
    const matches = current.connections.filter(
      (entry) =>
        entry.id === selector ||
        entry.installationId === selector ||
        entry.displayName.toLowerCase() === selector.toLowerCase() ||
        (normalizedUrl !== null && entry.apiUrl === normalizedUrl),
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `platform: No installed or connected platform matches ${JSON.stringify(selector)}.`
          : `platform: More than one platform matches ${JSON.stringify(selector)}. Use its id or URL.`,
      );
    }
    const selected = { ...matches[0]!, lastUsedAt: new Date().toISOString() };
    const connections = current.connections.map((entry) =>
      entry.id === selected.id ? selected : entry,
    );
    writeJsonAtomically(join(directory, 'registry.json'), {
      activeConnectionId: selected.id,
      connections,
      schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
    });
    return selected;
  });
}

export function installationManifestPath(
  accountId: string,
  installationId: string,
  directory: string = platformRegistryDirectory(),
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{7,79}$/.test(installationId)) {
    throw new Error('platform: Invalid account or installation id.');
  }
  return join(directory, accountId, `${installationId}.json`);
}

export function writeInstallationManifest(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): void {
  const path = installationManifestPath(manifest.account.id, manifest.id, directory);
  const parent = join(directory, manifest.account.id);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeJsonAtomically(path, manifest);
}

export function listInstallationManifests(
  directory: string = platformRegistryDirectory(),
): ReadonlyArray<PlatformInstallationManifest> {
  const manifests: Array<PlatformInstallationManifest> = [];
  let accountDirectories: Array<string>;
  try {
    accountDirectories = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  for (const accountId of accountDirectories) {
    const accountPath = join(directory, accountId);
    for (const entry of readdirSync(accountPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const path = join(accountPath, entry.name);
      try {
        manifests.push(parsePlatformInstallationManifest(JSON.parse(readFileSync(path, 'utf8'))));
      } catch (error) {
        throw new Error(
          `platform: Invalid installation manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return manifests.sort((left, right) =>
    left.deployment.displayName.localeCompare(right.deployment.displayName),
  );
}

export function resolveInstallationManifest(
  selector: string,
  directory: string = platformRegistryDirectory(),
): PlatformInstallationManifest {
  const manifests = listInstallationManifests(directory).filter(
    (manifest) =>
      manifest.status !== 'uninstalled' &&
      (!selector ||
        manifest.id === selector ||
        manifest.deployment.installationSlug === selector ||
        manifest.deployment.displayName.toLowerCase() === selector.toLowerCase()),
  );
  if (manifests.length !== 1) {
    throw new Error(
      manifests.length === 0
        ? `platform: No local installation matches ${JSON.stringify(selector)}.`
        : 'platform: Multiple local installations match; specify an installation id.',
    );
  }
  return manifests[0]!;
}

export function writePendingInstallationSecrets(
  manifest: PlatformInstallationManifest,
  secrets: Record<string, string>,
  directory: string = platformRegistryDirectory(),
): void {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  writeJsonAtomically(manifestPath.replace(/\.json$/, '.secrets'), secrets);
}

export function readPendingInstallationSecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): Record<string, string> | null {
  const path = installationManifestPath(manifest.account.id, manifest.id, directory).replace(
    /\.json$/,
    '.secrets',
  );
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('secret checkpoint must be an object');
    }
    const entries = Object.entries(value);
    if (entries.some(([, entry]) => typeof entry !== 'string')) {
      throw new Error('secret checkpoint values must be strings');
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `platform: Could not read pending installation secrets: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function removePendingInstallationSecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): void {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  rmSync(manifestPath.replace(/\.json$/, '.secrets'), { force: true });
}

export function promoteInstallationSecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): void {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  const pending = manifestPath.replace(/\.json$/, '.secrets');
  const recovery = manifestPath.replace(/\.json$/, '.recovery');
  renameSync(pending, recovery);
}

export function readInstallationRecoverySecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): Record<string, string> | null {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  const recovery = manifestPath.replace(/\.json$/, '.recovery');
  try {
    const value = JSON.parse(readFileSync(recovery, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('recovery material must be an object');
    }
    const entries = Object.entries(value);
    if (entries.some(([, entry]) => typeof entry !== 'string')) {
      throw new Error('recovery material values must be strings');
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return readPendingInstallationSecrets(manifest, directory);
    }
    throw new Error(
      `platform: Could not read installation recovery material: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function removeInstallationRecoverySecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): void {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  rmSync(manifestPath.replace(/\.json$/, '.recovery'), { force: true });
  rmSync(manifestPath.replace(/\.json$/, '.secrets'), { force: true });
}

export function removePlatformConnectionForInstallation(
  installationId: string,
  directory: string = platformRegistryDirectory(),
): void {
  withRegistryLock(directory, () => {
    const current = readRegistry(directory);
    const connections = current.connections.filter(
      (connection) => connection.installationId !== installationId,
    );
    writeJsonAtomically(join(directory, 'registry.json'), {
      activeConnectionId:
        current.activeConnectionId &&
        connections.some((connection) => connection.id === current.activeConnectionId)
          ? current.activeConnectionId
          : (connections[0]?.id ?? null),
      connections,
      schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
    });
  });
}
