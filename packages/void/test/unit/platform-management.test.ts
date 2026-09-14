import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationResource,
  transitionInstallation,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
  type ResourceOwnership,
} from '@void/platform';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { disablePlatform, uninstallPlatform } from '../../src/cli/platform-management.ts';
import {
  listInstallationManifests,
  promoteInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';

const directories: Array<string> = [];

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function installedManifest(zoneOwnership: ResourceOwnership = 'created') {
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment: createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    }),
    id: 'example-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
  const resources: Array<[string, InstallationResourceKind, ResourceOwnership]> = [
    ['zone', 'zone', zoneOwnership],
    ['application-dns', 'dns-record', 'created'],
    ['ai-gateway', 'ai-gateway', 'created'],
    ['routing-kv', 'kv-namespace', 'created'],
    ['isr-cache-kv', 'kv-namespace', 'created'],
    ['legacy-assets-kv', 'kv-namespace', 'created'],
    ['assets-bucket', 'r2-bucket', 'created'],
    ['usage-queue', 'queue', 'created'],
    ['cron-queue', 'queue', 'created'],
    ['dispatch-namespace', 'dispatch-namespace', 'created'],
    ['hyperdrive', 'hyperdrive', 'created'],
    ['api-worker', 'worker', 'created'],
    ['proxy-worker', 'worker', 'created'],
    ['tail-worker', 'worker', 'created'],
    ['dispatch-worker', 'worker', 'created'],
  ];
  for (const [key, kind, ownership] of resources) {
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: kind === 'worker' ? `void-example-${key.replace('-worker', '')}` : `${key}-id`,
        key,
        kind,
        name: key,
        ownership,
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
  }
  for (const status of [
    'planned',
    'provisioning',
    'deploying',
    'verifying',
    'installed',
  ] as const) {
    manifest = transitionInstallation(manifest, status, '2026-09-14T00:00:02.000Z');
  }
  return manifest;
}

function persist(manifest: PlatformInstallationManifest): void {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-management-test-'));
  directories.push(directory);
  process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
  writeInstallationManifest(manifest);
  writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://recovery' });
  promoteInstallationSecrets(manifest);
}

function client() {
  const deleted: Array<[string, string]> = [];
  const emptiedBuckets: Array<string> = [];
  const remoteWrites: Array<string> = [];
  let removedRoutes = 0;
  return {
    deleted,
    emptiedBuckets,
    remoteWrites,
    get removedRoutes() {
      return removedRoutes;
    },
    deleteKvValue: async () => {
      remoteWrites.push('delete');
    },
    deleteResource: async (_account: string, kind: string, id: string) => {
      deleted.push([kind, id]);
    },
    emptyR2Bucket: async (_account: string, bucket: string) => {
      emptiedBuckets.push(bucket);
    },
    putKvValue: async (_account: string, _namespace: string, _key: string, value: string) => {
      remoteWrites.push(value);
    },
    removeRoutes: async () => {
      removedRoutes++;
    },
  };
}

const uninstallArgs = {
  subcommand: 'uninstall' as const,
  selector: '',
  plan: false,
  purgeData: false,
  deleteZone: null,
};

describe('platform lifecycle management', () => {
  it('disables routes without deleting resources', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client();
    await disablePlatform(fake, manifest, false);
    expect(fake.removedRoutes).toBe(1);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
    expect(JSON.parse(fake.remoteWrites[0]!)).toMatchObject({ status: 'disabled' });
  });

  it('retains installer-owned data and the zone by default', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client();
    await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
    });
    expect(fake.deleted.map(([kind]) => kind).sort()).toEqual([
      'dns-record',
      'queue',
      'queue',
      'worker',
      'worker',
      'worker',
      'worker',
    ]);
    expect(fake.deleted.some(([kind]) => kind === 'zone')).toBe(false);
    const result = listInstallationManifests()[0]!;
    expect(result.status).toBe('uninstalled');
    expect(result.resources.find((resource) => resource.key === 'zone')?.state).toBe('retained');
  });

  it('removes the remote ownership marker when retaining data', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client();
    await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
    });
    expect(fake.deleted.map(([kind]) => kind).sort()).toEqual([
      'dns-record',
      'queue',
      'queue',
      'worker',
      'worker',
      'worker',
      'worker',
    ]);
    expect(fake.remoteWrites).toContain('delete');
    const retained = listInstallationManifests()[0]!.resources.filter(
      (resource) => resource.state === 'retained',
    );
    expect(retained).toHaveLength(8);
  });

  it('purges installer-owned data while never deleting an adopted zone', async () => {
    const manifest = installedManifest('adopted');
    persist(manifest);
    const fake = client();
    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true, deleteZone: true },
      {
        interactive: false,
      },
    );
    expect(fake.deleted).toHaveLength(14);
    expect(fake.emptiedBuckets).toEqual(['assets-bucket']);
    expect(fake.deleted.some(([kind]) => kind === 'zone')).toBe(false);
  });

  it('resumes safely after a deletion failure without retrying completed deletions', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client();
    const originalDelete = first.deleteResource;
    first.deleteResource = async (account, kind, id) => {
      if (kind === 'queue') {
        throw new Error('temporary deletion failure');
      }
      await originalDelete(account, kind, id);
    };
    await expect(
      uninstallPlatform(first, manifest, uninstallArgs, {
        interactive: false,
      }),
    ).rejects.toThrow('temporary deletion failure');
    const checkpoint = listInstallationManifests()[0]!;
    expect(checkpoint.status).toBe('failed');
    expect(checkpoint.resources.filter((resource) => resource.state === 'deleted')).toHaveLength(4);

    const second = client();
    await uninstallPlatform(second, checkpoint, uninstallArgs, {
      interactive: false,
    });
    expect(second.deleted.filter(([kind]) => kind === 'worker')).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('cleans up a partial installation without PostgreSQL or a recorded zone', async () => {
    const manifest = {
      ...installedManifest(),
      resources: installedManifest().resources.filter((resource) => resource.key !== 'zone'),
    };
    persist(manifest);
    const fake = client();
    await uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false });
    expect(fake.removedRoutes).toBe(0);
    expect(fake.deleted.some(([kind]) => kind === 'worker')).toBe(true);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(
      listInstallationManifests()[0]?.resources.find(
        (resource) => resource.key === 'application-dns',
      )?.state,
    ).toBe('retained');
  });

  it('resumes after routes were removed but remote disable checkpointing failed', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client();
    first.putKvValue = async () => {
      throw new Error('temporary KV failure');
    };
    await expect(disablePlatform(first, manifest, false)).rejects.toThrow('temporary KV failure');
    expect(listInstallationManifests()[0]?.status).toBe('failed');

    const second = client();
    await disablePlatform(second, listInstallationManifests()[0]!, false);
    expect(second.removedRoutes).toBe(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });
});
