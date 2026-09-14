import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationResource,
  setInstallationEndpoints,
  transitionInstallation,
  type InstallationResourceKind,
} from '@void/platform';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { REMOTE_INSTALLATION_MANIFEST_KEY } from '../../src/cli/platform-installer.ts';
import { recoverPlatformInstallations } from '../../src/cli/platform-recovery.ts';
import {
  listInstallationManifests,
  listPlatformConnections,
} from '../../src/cli/platform-registry.ts';

const directories: Array<string> = [];

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function remoteManifest() {
  const deployment = createPlatformDeploymentManifest({
    application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
    displayName: 'Example',
    installationSlug: 'example',
  });
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment,
    id: 'example-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
  const resources: Array<[string, InstallationResourceKind, string, string]> = [
    ['zone', 'zone', 'zone-id', 'example.com'],
    ['application-dns', 'dns-record', 'dns-id', '*.apps.example.com'],
    ['ai-gateway', 'ai-gateway', deployment.resources.aiGateway, deployment.resources.aiGateway],
    ['routing-kv', 'kv-namespace', 'routing-id', deployment.resources.routingKv],
    ['isr-cache-kv', 'kv-namespace', 'isr-id', deployment.resources.isrCacheKv],
    ['legacy-assets-kv', 'kv-namespace', 'legacy-id', deployment.resources.legacyAssetsKv],
    [
      'assets-bucket',
      'r2-bucket',
      deployment.resources.assetsBucket,
      deployment.resources.assetsBucket,
    ],
    ['usage-queue', 'queue', 'usage-id', deployment.resources.usageQueue],
    ['cron-queue', 'queue', 'cron-id', deployment.resources.cronQueue],
    [
      'dispatch-namespace',
      'dispatch-namespace',
      'dispatch-id',
      deployment.resources.dispatchNamespace,
    ],
    ['hyperdrive', 'hyperdrive', 'hyperdrive-id', deployment.resources.hyperdrive],
    ['api-worker', 'worker', deployment.resources.apiWorker, deployment.resources.apiWorker],
    ['proxy-worker', 'worker', deployment.resources.proxyWorker, deployment.resources.proxyWorker],
    ['tail-worker', 'worker', deployment.resources.tailWorker, deployment.resources.tailWorker],
    [
      'dispatch-worker',
      'worker',
      deployment.resources.dispatchWorker,
      deployment.resources.dispatchWorker,
    ],
  ];
  for (const [key, kind, id, name] of resources) {
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id,
        key,
        kind,
        name,
        ownership: 'created',
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
  return setInstallationEndpoints(
    manifest,
    {
      apiUrl: 'https://void-example-api.example-workers.workers.dev',
      dashboardUrl: null,
      proxyUrl: null,
    },
    '2026-09-14T00:00:03.000Z',
  );
}

function client(manifest = remoteManifest()) {
  const byName = new Map(manifest.resources.map((resource) => [resource.name, resource]));
  return {
    verifyToken: async () => {},
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    getWorkersSubdomain: async () => 'example-workers',
    listAiGateways: async () => [
      {
        id: manifest.deployment.resources.aiGateway,
        name: manifest.deployment.resources.aiGateway,
      },
    ],
    findZone: async () => ({
      id: 'zone-id',
      name: 'example.com',
      nameServers: [],
      status: 'active',
    }),
    listDnsRecords: async () => [
      {
        content: '100::',
        id: 'dns-id',
        name: '*.apps.example.com',
        proxied: true,
        type: 'AAAA',
      },
    ],
    listKvNamespaces: async (_account: string, title?: string) => {
      if (!title) {
        return [{ id: 'routing-id', name: manifest.deployment.resources.routingKv }];
      }
      const resource = byName.get(title);
      return resource?.kind === 'kv-namespace' ? [{ id: resource.id, name: resource.name }] : [];
    },
    getKvValue: async (_account: string, namespace: string, key: string) =>
      namespace === 'routing-id' && key === REMOTE_INSTALLATION_MANIFEST_KEY
        ? JSON.stringify(manifest)
        : null,
    listR2Buckets: async () => [
      {
        id: manifest.deployment.resources.assetsBucket,
        name: manifest.deployment.resources.assetsBucket,
      },
    ],
    listQueues: async (_account: string, name: string) => {
      const resource = byName.get(name);
      return resource?.kind === 'queue' ? [{ id: resource.id, name: resource.name }] : [];
    },
    listDispatchNamespaces: async () => [
      { id: 'dispatch-id', name: manifest.deployment.resources.dispatchNamespace },
    ],
    listHyperdriveConfigs: async () => [
      { id: 'hyperdrive-id', name: manifest.deployment.resources.hyperdrive },
    ],
    listWorkerNames: async () => [
      manifest.deployment.resources.apiWorker,
      manifest.deployment.resources.proxyWorker,
      manifest.deployment.resources.tailWorker,
      manifest.deployment.resources.dispatchWorker,
    ],
  };
}

describe('platform recovery', () => {
  it('recovers a fully verified remote ownership manifest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-recovery-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const verified: Array<string> = [];
    const recovered = await recoverPlatformInstallations(client(), 'account', async (manifest) => {
      verified.push(manifest.id);
    });
    expect(recovered).toHaveLength(1);
    expect(verified).toEqual(['example-a1b2c3d4']);
    expect(listInstallationManifests(directory)).toEqual(recovered);
    expect(listPlatformConnections(directory)[0]).toMatchObject({
      installationId: 'example-a1b2c3d4',
      kind: 'installed',
    });
  });

  it('refuses ownership metadata from a different routing namespace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-recovery-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const manifest = remoteManifest();
    const tampered = {
      ...manifest,
      resources: manifest.resources.map((resource) =>
        resource.key === 'routing-kv' ? { ...resource, id: 'different-id' } : resource,
      ),
    };
    await expect(
      recoverPlatformInstallations(client(tampered), 'account', async () => {}),
    ).rejects.toThrow('does not match');
    expect(listInstallationManifests(directory)).toEqual([]);
  });
});
