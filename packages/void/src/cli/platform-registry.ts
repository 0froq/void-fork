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
import { homedir } from 'node:os';
import {
  parsePlatformInstallationManifest,
  type PlatformInstallationManifest,
} from '@void/platform';
import { join } from 'pathslash';

export const PLATFORM_REGISTRY_SCHEMA_VERSION = 1 as const;

export type PlatformConnection = Readonly<{
  accountId: string | null;
  apiUrl: string;
  displayName: string;
  id: string;
  installationId: string | null;
  kind: 'connected' | 'installed';
  lastUsedAt: string;
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
  return join(homedir(), '.void', 'platforms');
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
  return {
    accountId: optionalString(entry.accountId),
    apiUrl,
    displayName:
      typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim()
        : new URL(apiUrl).hostname,
    id,
    installationId: optionalString(entry.installationId),
    kind: entry.kind,
    lastUsedAt,
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
