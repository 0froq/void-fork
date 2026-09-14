import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationResource,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import { createPlatformInstallPlan } from '../../src/cli/platform-plan.ts';

function client(overrides: Record<string, unknown> = {}) {
  return {
    verifyToken: async () => {},
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    getWorkersSubdomain: async () => 'example',
    findZone: async () => null,
    listKvNamespaces: async () => [],
    listR2Buckets: async () => [],
    listQueues: async () => [],
    listDispatchNamespaces: async () => [],
    listHyperdriveConfigs: async () => [],
    listWorkerNames: async () => [],
    ...overrides,
  };
}

const input = {
  accountId: 'account',
  applicationDomain: 'apps.example.com',
  controlPlaneDomain: '',
  dedicatedZone: false,
  displayName: 'Example',
  installationSlug: 'example',
  zoneName: 'example.com',
};

describe('platform installation planning', () => {
  it('builds a read-only core plan without containers', async () => {
    const fake = client();
    const plan = await createPlatformInstallPlan(fake, input, null);
    expect(plan.apiUrl).toBe('https://void-example-api.example.workers.dev');
    expect(plan.actions).toHaveLength(13);
    expect(plan.actions.every((action) => action.action === 'create')).toBe(true);
    expect(Object.keys(fake)).not.toContain('createZone');
  });

  it('fails closed on an unowned deterministic-name collision', async () => {
    const fake = client({
      listKvNamespaces: async (_account: string, title: string) =>
        title === 'void-example-routing' ? [{ id: 'someone-else', name: title }] : [],
    });
    await expect(createPlatformInstallPlan(fake, input, null)).rejects.toThrow('not owned');
  });

  it('adopts an existing zone without claiming ownership', async () => {
    const fake = client({
      findZone: async () => ({
        id: 'zone',
        name: 'example.com',
        nameServers: [],
        status: 'active',
      }),
    });
    const plan = await createPlatformInstallPlan(fake, input, null);
    expect(plan.actions[0]).toMatchObject({ action: 'adopt', id: 'zone', kind: 'zone' });
  });

  it('repairs a missing installer-owned resource', async () => {
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
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'missing-routing',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(client(), input, manifest, {
      repairMissing: true,
    });
    expect(plan.actions.find((action) => action.key === 'routing-kv')).toMatchObject({
      action: 'create',
      id: null,
    });
  });

  it('refuses to recreate a missing adopted resource', async () => {
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
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'external-routing',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'adopted',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    await expect(
      createPlatformInstallPlan(client(), input, manifest, { repairMissing: true }),
    ).rejects.toThrow('will not recreate');
  });
});
