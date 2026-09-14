import { createPlatformDeploymentManifest, createPlatformWorkerConfigs } from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';

describe('platform Worker configuration', () => {
  it('keeps the core installation free of containers and managed-build bindings', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
      accountId: 'account',
      apiUrl: 'https://void-example-api.example.workers.dev',
      deployment,
      installationId: 'example-a1b2c3d4',
      platformVersion: '1.0.0',
      resources: {
        hyperdrive: 'hyperdrive',
        isrCacheKv: 'isr',
        legacyAssetsKv: 'assets',
        routingKv: 'routing',
        zone: 'zone',
      },
      runtimeEntrypoints: {
        api: '/runtime/api.js',
        dispatch: '/runtime/dispatch.js',
        proxy: '/runtime/proxy.js',
        tail: '/runtime/tail.js',
      },
    });

    expect(configs.api).not.toHaveProperty('containers');
    expect(JSON.stringify(configs)).not.toContain('BuildManager');
    expect(JSON.stringify(configs)).not.toContain('BUILD_SCHEDULER');
    expect(configs.proxy.vars).toEqual({
      PLATFORM_CAPABILITIES: JSON.stringify(deployment.capabilities),
    });
    expect(configs.dispatch.routes).toEqual([
      { pattern: '*.apps.example.com/*', zone_name: 'example.com' },
      { pattern: '*.apps.example.com', zone_name: 'example.com' },
    ]);
  });
});
