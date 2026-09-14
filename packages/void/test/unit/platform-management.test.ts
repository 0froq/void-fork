import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
  type ResourceOwnership,
} from '@void/platform';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  disablePlatform,
  selectAuthoritativePlatformManifest,
  uninstallPlatform,
  verifyPlatformInstallationOwnership,
} from '../../src/cli/platform-management.ts';
import { platformProvisionIntentHash } from '../../src/cli/platform-plan.ts';
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

function client(manifest: PlatformInstallationManifest) {
  const deleted: Array<[string, string]> = [];
  const emptiedBuckets: Array<string> = [];
  const preservedBucketKeys: Array<ReadonlyArray<string>> = [];
  const deletedBucketMarkers: Array<string> = [];
  const remoteWrites: Array<string> = [];
  const subdomains: Array<[string, boolean]> = [];
  let removedRoutes = 0;
  return {
    deleted,
    emptiedBuckets,
    preservedBucketKeys,
    deletedBucketMarkers,
    remoteWrites,
    subdomains,
    get removedRoutes() {
      return removedRoutes;
    },
    deleteResource: async (_account: string, kind: string, id: string) => {
      deleted.push([kind, id]);
    },
    deleteR2Object: async (_account: string, bucket: string) => {
      deletedBucketMarkers.push(bucket);
    },
    emptyR2Bucket: async (
      _account: string,
      bucket: string,
      preservedKeys?: ReadonlySet<string>,
    ) => {
      emptiedBuckets.push(bucket);
      preservedBucketKeys.push([...(preservedKeys ?? [])]);
    },
    findZone: async (_account: string, name: string) => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'zone' && entry.name === name && entry.state === 'ready',
      );
      return resource
        ? { id: resource.id, name: resource.name, nameServers: [], status: 'active' }
        : null;
    },
    getKvValue: async (): Promise<string | null> => JSON.stringify(manifest),
    getR2Object: async () => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'r2-bucket' && entry.state === 'ready',
      );
      return resource ? ownershipMarker(manifest, resource) : null;
    },
    getWorkerPlainTextBindings: async (
      _account: string,
      name: string,
    ): Promise<Record<string, string>> => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name && entry.state === 'ready',
      );
      if (!resource) {
        return {};
      }
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(manifest, resource) };
    },
    listAiGateways: async () => namedResources(manifest, 'ai-gateway'),
    listDispatchNamespaces: async () => namedResources(manifest, 'dispatch-namespace'),
    listDnsRecords: async (_zone: string, name: string) =>
      namedResources(manifest, 'dns-record')
        .filter((resource) => resource.name === name)
        .map((resource) => ({ ...resource, content: '100::', proxied: true, type: 'AAAA' })),
    listHyperdriveConfigs: async () => namedResources(manifest, 'hyperdrive'),
    listKvNamespaces: async () => namedResources(manifest, 'kv-namespace'),
    listQueues: async (_account: string, name: string) =>
      namedResources(manifest, 'queue').filter((resource) => resource.name === name),
    listR2Buckets: async () =>
      namedResources(manifest, 'r2-bucket').map((resource) => ({
        ...resource,
        fingerprint: '2026-09-14T00:00:00.000Z',
      })),
    listWorkerNames: async () =>
      namedResources(manifest, 'worker').map((resource) => resource.name),
    putKvValue: async (_account: string, _namespace: string, _key: string, value: string) => {
      remoteWrites.push(value);
    },
    removeRoutes: async (_account: string, _zone: string | null, _workers: ReadonlySet<string>) => {
      removedRoutes++;
    },
    setWorkerSubdomain: async (_account: string, worker: string, enabled: boolean) => {
      subdomains.push([worker, enabled]);
    },
  };
}

function namedResources(manifest: PlatformInstallationManifest, kind: InstallationResourceKind) {
  return manifest.resources
    .filter((resource) => resource.kind === kind && resource.state === 'ready')
    .map((resource) => ({ id: resource.id, name: resource.name }));
}

function ownershipMarker(
  manifest: PlatformInstallationManifest,
  resource: PlatformInstallationManifest['resources'][number],
): string {
  return JSON.stringify(
    createPlatformResourceOwnershipMarker({
      accountId: manifest.account.id,
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      resourceId: resource.id,
      resourceKey: resource.key,
      resourceKind: resource.kind,
      resourceName: resource.name,
    }),
  );
}

const uninstallArgs = {
  subcommand: 'uninstall' as const,
  selector: '',
  plan: false,
  purgeData: false,
  deleteZone: null,
};

describe('platform lifecycle management', () => {
  it('retries an eventually consistent ownership checkpoint before mutation', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'api-worker'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    let reads = 0;
    fake.getKvValue = async () => JSON.stringify(++reads === 1 ? stale : manifest);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it('allows authoritative repair to recreate a confirmed-missing routing checkpoint', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;
    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote installation checkpoint is missing',
    );
    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowMissingRoutingCheckpoint: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('still rejects a replacement R2 bucket while repairing a missing routing checkpoint', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;
    fake.getR2Object = async () => null;
    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );

    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowMissingRoutingCheckpoint: true,
      }),
    ).rejects.toThrow('r2-bucket assets-bucket has no ownership marker');
  });

  it('accepts a live immutable resource recorded ahead of stale routing KV', async () => {
    let manifest = installedManifest();
    const resource = manifest.resources.find((entry) => entry.key === 'isr-cache-kv')!;
    const intent = {
      completedAt: '2026-09-14T00:00:01.000Z',
      key: `provision-intent:${resource.key}`,
      resultHash: platformProvisionIntentHash(manifest, resource.key, resource.kind, resource.name),
    };
    manifest = recordInstallationStep(manifest, intent, '2026-09-14T00:00:02.000Z');
    const stale = recordInstallationStep(
      {
        ...manifest,
        resources: manifest.resources.filter((resource) => resource.key !== 'isr-cache-kv'),
      },
      intent,
      '2026-09-14T00:00:01.000Z',
    );
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
  });

  it('rejects a locally appended live resource without a remote provision intent', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'cron-queue'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote checkpoint does not own queue cron-queue',
    );
  });

  it('never recovers a reusable AI Gateway name from stale routing KV', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'ai-gateway'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'does not own ai-gateway',
    );
  });

  it('refuses to resume installation over a replacement Worker', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getWorkerPlainTextBindings = async () => ({});

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'has no ownership marker',
    );
  });

  it('refuses to resume installation into a replacement R2 bucket', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getR2Object = async () => null;

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'has no ownership marker',
    );
  });

  it('disables routes without deleting resources', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    const databaseCheckpoints: Array<PlatformInstallationManifest> = [];
    await disablePlatform(fake, manifest, false, {
      checkpoint: async (checkpoint) => {
        databaseCheckpoints.push(checkpoint);
      },
    });
    expect(fake.removedRoutes).toBe(1);
    expect(fake.subdomains).toEqual([
      ['api-worker', false],
      ['dispatch-worker', false],
      ['proxy-worker', false],
      ['tail-worker', false],
    ]);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
    expect(JSON.parse(fake.remoteWrites[0]!)).toMatchObject({ status: 'disabling' });
    expect(JSON.parse(fake.remoteWrites.at(-1)!)).toMatchObject({ status: 'disabled' });
    expect(databaseCheckpoints.at(-1)?.status).toBe('disabled');
  });

  it('selects cross-host disabled and uninstalled state over a stale local manifest', () => {
    const local = installedManifest();
    const disabled = { ...local, desiredState: 'disabled' as const, status: 'disabled' as const };
    const uninstalled = { ...disabled, status: 'uninstalled' as const };

    expect(selectAuthoritativePlatformManifest(local, disabled)).toBe(disabled);
    expect(selectAuthoritativePlatformManifest(local, uninstalled)).toBe(uninstalled);
  });

  it('removes public endpoints again after a platform is re-enabled', async () => {
    let manifest = installedManifest();
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'traffic-enabled:1',
        resultHash: '1',
      },
      '2026-09-14T00:00:03.000Z',
    );
    persist(manifest);
    const first = client(manifest);
    await disablePlatform(first, manifest, false);

    let reenabled = listInstallationManifests()[0]!;
    reenabled = recordInstallationStep(
      reenabled,
      {
        completedAt: '2026-09-14T00:00:04.000Z',
        key: 'traffic-enabled:2',
        resultHash: '2',
      },
      '2026-09-14T00:00:04.000Z',
    );
    reenabled = { ...reenabled, desiredState: 'enabled', status: 'installed' };
    writeInstallationManifest(reenabled);

    const second = client(reenabled);
    await disablePlatform(second, reenabled, false);
    expect(second.removedRoutes).toBe(1);
    expect(second.subdomains).toHaveLength(4);
  });

  it('disables public Workers from an interrupted deployment', async () => {
    const manifest = { ...installedManifest(), status: 'deploying' as const };
    persist(manifest);
    const fake = client(manifest);

    await disablePlatform(fake, manifest, false);

    expect(fake.removedRoutes).toBe(1);
    expect(fake.subdomains).toHaveLength(4);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('disables every surviving Worker when one recorded Worker is missing', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.listWorkerNames = async () => ['api-worker', 'proxy-worker', 'tail-worker'];

    await disablePlatform(fake, manifest, false);

    expect(fake.subdomains).toEqual([
      ['api-worker', false],
      ['proxy-worker', false],
      ['tail-worker', false],
    ]);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('disables workers.dev and custom domains when the recorded zone is missing', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.findZone = async () => null;
    let routeZone: string | null | undefined;
    fake.removeRoutes = async (_account, zone) => {
      routeZone = zone;
    };

    await disablePlatform(fake, manifest, false);

    expect(routeZone).toBeNull();
    expect(fake.subdomains).toHaveLength(4);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('disables a marked Worker deployed before its local resource checkpoint', async () => {
    let manifest = installedManifest();
    const recordedApi = manifest.resources.find((resource) => resource.key === 'api-worker')!;
    const api = {
      ...recordedApi,
      id: manifest.deployment.resources.apiWorker,
      name: manifest.deployment.resources.apiWorker,
    };
    manifest = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'api-worker'),
      status: 'deploying',
    };
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(manifest, api.key, api.kind, api.name),
      },
      '2026-09-14T00:00:03.000Z',
    );
    persist(manifest);
    const fake = client(manifest);
    fake.listWorkerNames = async () => [
      api.name,
      ...manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.name),
    ];
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource =
        name === api.name
          ? api
          : manifest.resources.find((entry) => entry.kind === 'worker' && entry.name === name)!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(manifest, resource) };
    };

    await disablePlatform(fake, manifest, false);

    expect(fake.subdomains).toContainEqual([api.name, false]);
    expect(
      listInstallationManifests()[0]?.resources.find((resource) => resource.key === api.key),
    ).toMatchObject({
      id: api.id,
      kind: api.kind,
      name: api.name,
      ownership: 'created',
      state: 'ready',
    });
  });

  it('retains installer-owned data and the zone by default', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
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

  it('records the completed uninstall in retained routing storage', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
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
    expect(fake.remoteWrites.map((value) => JSON.parse(value).status)).toContain('uninstalled');
    const retained = listInstallationManifests()[0]!.resources.filter(
      (resource) => resource.state === 'retained',
    );
    expect(retained).toHaveLength(8);
  });

  it('purges installer-owned data while never deleting an adopted zone', async () => {
    const manifest = installedManifest('adopted');
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true, deleteZone: true },
      {
        interactive: false,
      },
    );
    expect(fake.deleted).toHaveLength(13);
    expect(fake.deleted).not.toContainEqual(['ai-gateway', 'ai-gateway-id']);
    expect(fake.emptiedBuckets).toEqual(['assets-bucket']);
    expect(fake.preservedBucketKeys).toEqual([['__void/platform/ownership/v1']]);
    expect(fake.deletedBucketMarkers).toEqual(['assets-bucket']);
    expect(fake.deleted).toContainEqual(['r2-bucket', 'assets-bucket-id']);
    expect(fake.deleted.some(([kind]) => kind === 'zone')).toBe(false);
  });

  it('revalidates R2 ownership after emptying and before deleting the marker', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    const originalEmpty = fake.emptyR2Bucket;
    let replaced = false;
    fake.emptyR2Bucket = async (account, bucket, preservedKeys) => {
      await originalEmpty(account, bucket, preservedKeys);
      replaced = true;
    };
    const originalMarker = fake.getR2Object;
    fake.getR2Object = async () => (replaced ? null : originalMarker());
    const originalBuckets = fake.listR2Buckets;
    fake.listR2Buckets = async () =>
      (await originalBuckets()).map((bucket) => ({
        ...bucket,
        fingerprint: replaced ? '2026-09-14T00:00:09.000Z' : bucket.fingerprint,
      }));

    await expect(
      uninstallPlatform(
        fake,
        { ...manifest, resources: manifest.resources },
        { ...uninstallArgs, purgeData: true },
        { interactive: false },
      ),
    ).rejects.toThrow('has no ownership marker');
    expect(fake.deletedBucketMarkers).toEqual([]);
    expect(fake.deleted).not.toContainEqual(['r2-bucket', 'assets-bucket-id']);
  });

  it('resumes R2 purge after the ownership marker was deleted', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    let markerPresent = true;
    const originalDeleteMarker = first.deleteR2Object;
    first.deleteR2Object = async (account: string, bucket: string) => {
      await originalDeleteMarker(account, bucket);
      markerPresent = false;
    };
    const originalMarker = first.getR2Object;
    first.getR2Object = async (...args) => (markerPresent ? originalMarker(...args) : null);
    const originalDelete = first.deleteResource;
    first.deleteResource = async (account: string, kind: string, id: string) => {
      if (kind === 'r2-bucket') {
        throw new Error('interrupted after marker deletion');
      }
      await originalDelete(account, kind, id);
    };

    await expect(
      uninstallPlatform(
        first,
        manifest,
        { ...uninstallArgs, purgeData: true },
        { interactive: false },
      ),
    ).rejects.toThrow('interrupted after marker deletion');
    const checkpoint = listInstallationManifests()[0]!;
    expect(checkpoint.steps.some((step) => step.key === 'delete-intent:assets-bucket')).toBe(true);

    const second = client(checkpoint);
    second.getR2Object = async () => null;
    await uninstallPlatform(
      second,
      checkpoint,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );
    expect(second.deleted).toContainEqual(['r2-bucket', 'assets-bucket-id']);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('refuses every mutation when the remote installation identity changed', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.getKvValue = async () =>
      JSON.stringify({ ...manifest, ownershipNonce: 'different-ownership-nonce-000000' });

    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false }),
    ).rejects.toThrow('remote installation identity does not match');
    expect(fake.removedRoutes).toBe(0);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('refuses to delete a replacement Worker with a reused name', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    const replacement = {
      ...manifest,
      ownershipNonce: 'replacement-owner-nonce-00000000',
    };
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource = replacement.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name,
      )!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(replacement, resource) };
    };

    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false }),
    ).rejects.toThrow('belongs to another installation');
    expect(fake.removedRoutes).toBe(0);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('refuses to purge a replacement R2 bucket without its ownership marker', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const fake = client(manifest);
    fake.getR2Object = async () => null;

    await expect(
      uninstallPlatform(
        fake,
        manifest,
        { ...uninstallArgs, purgeData: true },
        { interactive: false },
      ),
    ).rejects.toThrow('has no ownership marker');
    expect(fake.emptiedBuckets).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('resumes safely after a deletion failure without retrying completed deletions', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
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

    const second = client(checkpoint);
    await uninstallPlatform(second, checkpoint, uninstallArgs, {
      interactive: false,
    });
    expect(second.deleted.filter(([kind]) => kind === 'worker')).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('resumes a purge after the final routing checkpoint was ambiguously deleted', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    const originalDelete = first.deleteResource;
    first.deleteResource = async (account, kind, id) => {
      await originalDelete(account, kind, id);
      if (kind === 'kv-namespace' && id === 'routing-kv-id') {
        throw new Error('connection closed after routing deletion');
      }
    };
    await expect(
      uninstallPlatform(
        first,
        manifest,
        { ...uninstallArgs, purgeData: true },
        { interactive: false },
      ),
    ).rejects.toThrow('connection closed after routing deletion');
    const checkpoint = listInstallationManifests()[0]!;
    expect(checkpoint.status).toBe('failed');
    expect(checkpoint.resources.find((resource) => resource.key === 'routing-kv')?.state).toBe(
      'ready',
    );
    expect(
      checkpoint.resources.every(
        (resource) => resource.key === 'routing-kv' || resource.state !== 'ready',
      ),
    ).toBe(true);

    const second = client(checkpoint);
    second.getKvValue = async () => null;
    second.listKvNamespaces = async () =>
      namedResources(checkpoint, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );
    await uninstallPlatform(
      second,
      checkpoint,
      { ...uninstallArgs, purgeData: true },
      { interactive: false },
    );
    expect(second.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('cleans up a partial installation without PostgreSQL or a recorded zone', async () => {
    const manifest = {
      ...installedManifest(),
      resources: installedManifest().resources.filter((resource) => resource.key !== 'zone'),
    };
    persist(manifest);
    const fake = client(manifest);
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

  it('safely uninstalls a DNS-wait checkpoint created before routing storage', async () => {
    const manifest = {
      ...installedManifest(),
      endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
      resources: installedManifest().resources.filter((resource) => resource.key === 'zone'),
      status: 'waiting-for-dns' as const,
    };
    persist(manifest);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false });
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]).toMatchObject({ status: 'uninstalled' });
    expect(listInstallationManifests()[0]!.resources[0]).toMatchObject({ state: 'retained' });
  });

  it('resumes after routes were removed but remote disable checkpointing failed', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    first.putKvValue = async () => {
      throw new Error('temporary KV failure');
    };
    await expect(disablePlatform(first, manifest, false)).rejects.toThrow('temporary KV failure');
    expect(listInstallationManifests()[0]?.status).toBe('failed');

    const failed = listInstallationManifests()[0]!;
    const second = client(failed);
    await disablePlatform(second, failed, false);
    expect(second.removedRoutes).toBe(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('reasserts every public endpoint when disabling an already-disabled installation', async () => {
    const manifest = installedManifest();
    persist(manifest);
    const first = client(manifest);
    await disablePlatform(first, manifest, false);

    const disabled = listInstallationManifests()[0]!;
    const second = client(disabled);
    await disablePlatform(second, disabled, false);

    expect(second.removedRoutes).toBe(1);
    expect(second.subdomains).toHaveLength(4);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });
});
