import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import {
  recordPlatformWorkerTraffic,
  trackedPlatformWorkerTraffic,
} from '../../src/cli/platform-traffic.ts';

describe('platform traffic checkpoints', () => {
  it('records immutable route and custom-domain ids', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      controlPlane: { apiHostname: 'api.example.com' },
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
    manifest = recordPlatformWorkerTraffic(
      manifest,
      deployment.resources.apiWorker,
      {
        customDomains: [
          {
            hostname: 'api.example.com',
            id: 'domain-id',
            service: deployment.resources.apiWorker,
          },
        ],
        routes: [],
      },
      '2026-09-14T00:00:01.000Z',
    );
    manifest = recordPlatformWorkerTraffic(
      manifest,
      deployment.resources.dispatchWorker,
      {
        customDomains: [],
        routes: [
          {
            id: 'route-one',
            pattern: '*.apps.example.com/*',
            script: deployment.resources.dispatchWorker,
          },
          {
            id: 'route-two',
            pattern: '*.apps.example.com',
            script: deployment.resources.dispatchWorker,
          },
        ],
      },
      '2026-09-14T00:00:02.000Z',
    );

    expect(trackedPlatformWorkerTraffic(manifest)).toEqual({
      customDomains: [
        {
          hostname: 'api.example.com',
          id: 'domain-id',
          service: deployment.resources.apiWorker,
        },
      ],
      routes: [
        {
          id: 'route-one',
          pattern: '*.apps.example.com/*',
          script: deployment.resources.dispatchWorker,
        },
        {
          id: 'route-two',
          pattern: '*.apps.example.com',
          script: deployment.resources.dispatchWorker,
        },
      ],
    });
  });

  it('fails closed when published traffic is ambiguous or missing', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });

    expect(() =>
      recordPlatformWorkerTraffic(
        manifest,
        deployment.resources.dispatchWorker,
        { customDomains: [], routes: [] },
        '2026-09-14T00:00:01.000Z',
      ),
    ).toThrow('Expected exactly one published Worker route');
  });
});
