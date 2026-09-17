import { describe, expect, it } from 'vite-plus/test';
import { createPlatformDeploymentManifest } from '../../src/manifest.ts';
import { createPlatformWorkerConfigs } from '../../src/worker-config.ts';

describe('platform usage queue bindings', () => {
  it.each([
    {
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.example.com',
      workersDev: false,
      publicFetch: false,
    },
    {
      apiUrl: 'https://api.account.workers.dev',
      proxyUrl: 'https://proxy.example.com',
      workersDev: false,
      publicFetch: true,
    },
    {
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.account.workers.dev',
      workersDev: false,
      publicFetch: true,
    },
    {
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.example.com',
      workersDev: true,
      publicFetch: true,
    },
  ])(
    'supports public health probes without adding bootstrap service dependencies: $apiUrl, $proxyUrl, workersDev=$workersDev',
    ({ apiUrl, proxyUrl, workersDev, publicFetch }) => {
      const deployment = createPlatformDeploymentManifest({
        application: workersDev
          ? {
              baseDomain: 'account.workers.dev',
              zoneName: '',
              workersDev: { subdomain: 'account', installationId: 'example-123456abcdef' },
            }
          : { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      });
      const configs = createPlatformWorkerConfigs({
        accountId: 'account',
        apiUrl,
        proxyUrl,
        deployment,
        healthProbeToken: 'probe',
        installationId: 'example-123456abcdef',
        ownershipNonce: 'ownership',
        platformVersion: '1.0.0',
        resources: {
          hyperdrive: 'db',
          isrCacheKv: 'isr',
          legacyAssetsKv: 'assets',
          routingKv: 'routing',
          zone: workersDev ? '' : 'zone',
        },
        runtimeEntrypoints: {
          api: 'api.mjs',
          proxy: 'proxy.mjs',
          dispatch: 'dispatch.mjs',
          tail: 'tail.mjs',
        },
      });
      expect(configs.api.compatibility_flags).toEqual([
        'nodejs_compat',
        ...(publicFetch ? ['global_fetch_strictly_public'] : []),
      ]);
      expect(configs.api.services).toBeUndefined();
      expect(configs.proxy.compatibility_flags).toEqual(['nodejs_compat']);
      expect(configs.proxy.services).toEqual([
        { binding: 'API', service: deployment.resources.apiWorker },
      ]);
      expect(Object.keys(configs).sort()).toEqual(['api', 'dispatch', 'proxy', 'tail']);
    },
  );

  it('binds the existing queue only to trusted platform producers', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
      accountId: 'account',
      apiUrl: 'https://api.example.com',
      deployment,
      healthProbeToken: 'probe',
      installationId: 'installation',
      ownershipNonce: 'ownership',
      platformVersion: '1.0.0',
      proxyUrl: 'https://proxy.example.com',
      resources: {
        hyperdrive: 'hyperdrive-id',
        isrCacheKv: 'isr-id',
        legacyAssetsKv: 'assets-id',
        routingKv: 'routing-id',
        zone: 'zone-id',
      },
      runtimeEntrypoints: {
        api: 'api.mjs',
        dispatch: 'dispatch.mjs',
        proxy: 'proxy.mjs',
        tail: 'tail.mjs',
      },
    });

    expect((configs.api.queues as { producers: Array<unknown> }).producers).toContainEqual({
      binding: 'USAGE_EVENTS_QUEUE',
      queue: deployment.resources.usageQueue,
    });
    expect((configs.dispatch.queues as { producers: Array<unknown> }).producers).toEqual([
      { binding: 'USAGE_QUEUE', queue: deployment.resources.usageQueue },
    ]);
    expect(configs.proxy.queues).toBeUndefined();
    expect(configs.proxy.durable_objects).toBeUndefined();
    expect(configs.tail.queues).toBeUndefined();
  });

  it('creates core Durable Objects with SQLite while preserving migration tags', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
      accountId: 'account',
      apiUrl: 'https://api.example.com',
      deployment,
      healthProbeToken: 'probe',
      installationId: 'installation',
      ownershipNonce: 'ownership',
      platformVersion: '1.0.0',
      proxyUrl: 'https://proxy.example.com',
      resources: {
        hyperdrive: 'hyperdrive-id',
        isrCacheKv: 'isr-id',
        legacyAssetsKv: 'assets-id',
        routingKv: 'routing-id',
        zone: 'zone-id',
      },
      runtimeEntrypoints: {
        api: 'api.mjs',
        dispatch: 'dispatch.mjs',
        proxy: 'proxy.mjs',
        tail: 'tail.mjs',
      },
    });

    expect(configs.api.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['UsageCounter'] },
      { tag: 'v2', new_sqlite_classes: ['CronScheduler'] },
      { tag: 'v3', new_sqlite_classes: ['ErrorAlertMonitor'] },
      { tag: 'v4', new_sqlite_classes: ['SandboxConcurrencyCounter'] },
    ]);
  });
});
