import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  setInstallationEndpoints,
} from '@void/platform';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  getActivePlatformConnection,
  listInstallationManifests,
  listPlatformConnections,
  normalizePlatformApiUrl,
  platformCredentialAccount,
  savePlatformConnection,
  selectPlatformConnection,
  promoteInstallationSecrets,
  readInstallationRecoverySecrets,
  removeInstallationRecoverySecrets,
  writePendingInstallationSecrets,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';

const roots: Array<string> = [];

function temporaryRegistry(): string {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-registry-'));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('platform registry', () => {
  it('normalizes and validates API origins', () => {
    expect(normalizePlatformApiUrl('https://platform.example.com/')).toBe(
      'https://platform.example.com',
    );
    expect(normalizePlatformApiUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => normalizePlatformApiUrl('http://platform.example.com')).toThrow('HTTPS');
    expect(() => normalizePlatformApiUrl('https://user@example.com')).toThrow('credentials');
    expect(() => normalizePlatformApiUrl('https://example.com/api')).toThrow(
      'must not contain a path',
    );
  });

  it('stores credentials under an origin-scoped key', () => {
    expect(platformCredentialAccount('https://one.example.com')).not.toBe(
      platformCredentialAccount('https://two.example.com'),
    );
  });

  it('automatically selects one connection and persists an explicit selection', () => {
    const directory = temporaryRegistry();
    const first = savePlatformConnection(
      {
        accountId: null,
        apiUrl: 'https://one.example.com',
        applicationDomain: null,
        displayName: 'One',
        installationId: null,
        kind: 'connected',
        proxyUrl: 'https://proxy.one.example.com',
      },
      directory,
    );
    expect(getActivePlatformConnection(directory)).toEqual(first);
    savePlatformConnection(
      {
        accountId: null,
        apiUrl: 'https://two.example.com',
        applicationDomain: null,
        displayName: 'Two',
        installationId: null,
        kind: 'connected',
        proxyUrl: 'https://proxy.two.example.com',
      },
      directory,
    );
    expect(selectPlatformConnection('One', directory).id).toBe(first.id);
    expect(getActivePlatformConnection(directory)?.displayName).toBe('One');
    expect(listPlatformConnections(directory)).toHaveLength(2);
    expect(readFileSync(join(directory, 'registry.json'), 'utf8')).not.toContain('token');
  });

  it('writes and discovers exact installation manifests', () => {
    const directory = temporaryRegistry();
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account_123', name: 'Developer Platform Experience' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '0.10.13',
    });
    manifest = setInstallationEndpoints(
      manifest,
      { apiUrl: 'https://api.example.com', dashboardUrl: null, proxyUrl: null },
      '2026-09-14T00:00:00.000Z',
    );
    writeInstallationManifest(manifest, directory);
    expect(listInstallationManifests(directory)).toEqual([manifest]);
  });

  it('keeps recovery material private and removes it explicitly', () => {
    const directory = temporaryRegistry();
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account_123', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    writeInstallationManifest(manifest, directory);
    writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://secret' }, directory);
    promoteInstallationSecrets(manifest, directory);
    const recoveryPath = join(directory, 'account_123', 'example-a1b2c3d4.recovery');
    expect(statSync(recoveryPath).mode & 0o777).toBe(0o600);
    expect(readInstallationRecoverySecrets(manifest, directory)).toEqual({
      databaseUrl: 'postgres://secret',
    });
    removeInstallationRecoverySecrets(manifest, directory);
    expect(readInstallationRecoverySecrets(manifest, directory)).toBeNull();
  });
});
