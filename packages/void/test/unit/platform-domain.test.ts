import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  parsePlatformInstallationManifest,
  recordInstallationResource,
  PLATFORM_APPLICATION_KEY,
  platformProjectHostname,
  resolvePlatformApplicationEnvironment,
  type PlatformInstallationManifest,
} from '@void/platform';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { applyPlatformDomain, platformDomainTarget } from '../../src/cli/platform-domain.ts';
import type { PlatformInstallPlan } from '../../src/cli/platform-plan.ts';

function fixture() {
  const application = {
    baseDomain: 'test.workers.dev',
    zoneName: '',
    dedicatedZone: false,
    workersDev: { installationId: 'team-123456abcdef', subdomain: 'test' },
  };
  const deployment = createPlatformDeploymentManifest({
    installationSlug: 'team',
    displayName: 'Team',
    application,
  });
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-17T00:00:00Z',
    deployment,
    id: application.workersDev.installationId,
    ownershipNonce: 'test-nonce-123456789012345678901234567890',
    platformVersion: '1.0.0',
  });
  manifest = recordInstallationResource(
    { ...manifest, status: 'installed' },
    {
      key: 'routing-kv',
      id: 'routing',
      kind: 'kv-namespace',
      name: deployment.resources.routingKv,
      configHash: 'hash',
      ownership: 'created',
      state: 'ready',
    },
    manifest.updatedAt,
  );
  const zone = {
    id: 'zone',
    name: 'example.com',
    status: 'pending',
    nameServers: ['ns1.test', 'ns2.test'],
  };
  const target = platformDomainTarget(manifest, 'example.com', 'example.com', false);
  let current = manifest;
  const values = new Map<string, string>();
  const routes: Array<{ id: string; pattern: string; script: string }> = [];
  const client = {
    createZone: vi.fn(async () => zone),
    listDnsRecords: vi.fn(async () => []),
    createDnsRecord: vi.fn(async () => ({
      id: 'dns',
      name: '*.example.com',
      type: 'AAAA',
      content: '100::',
      proxied: true,
    })),
    publishWorkerRoutesSafely: vi.fn(
      async (_zone: string, script: string, patterns: Array<string>) => {
        for (const pattern of patterns) {
          if (!routes.some((route) => route.pattern === pattern)) {
            routes.push({ id: `route-${routes.length}`, pattern, script });
          }
        }
      },
    ),
    listWorkerRoutes: vi.fn(async () => routes),
    putKvValue: vi.fn(async (_account: string, _namespace: string, key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const plan = {
    account: manifest.account,
    actions: [
      { key: 'zone', kind: 'zone', action: 'create', name: 'example.com', id: null },
      {
        key: 'application-dns',
        kind: 'dns-record',
        action: 'create',
        name: '*.example.com',
        id: null,
      },
    ],
    zone: null,
  } as unknown as PlatformInstallPlan;
  const dependencies = {
    checkpoint: vi.fn(async (next: PlatformInstallationManifest) => {
      current = parsePlatformInstallationManifest(next);
    }),
    verifyOwnership: vi.fn(async () => {}),
    verifyRuntimeToken: vi.fn(async () => {}),
    probe: vi.fn(async () => {}),
  };
  return { client, current: () => current, dependencies, manifest, plan, target, zone, values };
}

describe('platform domain activation', () => {
  it('resumes after DNS and TLS waits without changing the original application before verification', async () => {
    const f = fixture();
    const client = f.client as unknown as PlatformCloudflareClient;
    const pending = await applyPlatformDomain(client, f.manifest, f.target, f.plan, f.dependencies);
    expect(pending.waitingForDns).toBe(true);
    expect(f.current().deployment).toEqual(f.manifest.deployment);
    expect(f.client.createDnsRecord).not.toHaveBeenCalled();
    expect(f.values.has(PLATFORM_APPLICATION_KEY)).toBe(false);
    f.zone.status = 'active';
    const resumedPlan = {
      ...f.plan,
      zone: f.zone,
      actions: f.plan.actions.map((action) =>
        action.key === 'zone' ? { ...action, action: 'reuse' as const, id: f.zone.id } : action,
      ),
    };
    f.dependencies.probe.mockRejectedValueOnce(new Error('TLS pending'));
    await expect(
      applyPlatformDomain(client, f.current(), f.target, resumedPlan, f.dependencies),
    ).rejects.toThrow('TLS pending');
    expect(f.values.has(PLATFORM_APPLICATION_KEY)).toBe(false);
    expect(f.current().deployment).toEqual(f.manifest.deployment);
    const finalPlan = {
      ...resumedPlan,
      actions: resumedPlan.actions.map((action) =>
        action.key === 'application-dns'
          ? { ...action, action: 'reuse' as const, id: 'dns' }
          : action,
      ),
    };
    const result = await applyPlatformDomain(
      client,
      f.current(),
      f.target,
      finalPlan,
      f.dependencies,
    );
    expect(result.waitingForDns).toBe(false);
    expect(result.manifest.pendingDomain).toBeUndefined();
    expect(result.manifest.endpoints).toEqual(f.manifest.endpoints);
    expect(result.manifest.deployment.application.baseDomain).toBe('example.com');
    expect(f.client.createZone).toHaveBeenCalledTimes(1);
    expect(f.client.createDnsRecord).toHaveBeenCalledTimes(1);
    const originalEnv = {
      PLATFORM_APPLICATION: JSON.stringify(f.manifest.deployment.application),
      ROUTING: { get: async (key: string) => f.values.get(key) ?? null },
    };
    const activeEnv = await resolvePlatformApplicationEnvironment(originalEnv);
    const project = { id: 'proj_123456abcdef', slug: 'my-app' };
    expect(platformProjectHostname(project, JSON.parse(activeEnv.PLATFORM_APPLICATION))).toBe(
      'my-app.example.com',
    );
    expect(JSON.parse(originalEnv.PLATFORM_APPLICATION).zoneName).toBe('');
  });
  it('stops on ownership or credential errors before making the domain live', async () => {
    const f = fixture();
    f.dependencies.verifyOwnership.mockRejectedValueOnce(new Error('wrong owner'));
    await expect(
      applyPlatformDomain(
        f.client as unknown as PlatformCloudflareClient,
        f.manifest,
        f.target,
        f.plan,
        f.dependencies,
      ),
    ).rejects.toThrow('wrong owner');
    expect(f.dependencies.checkpoint).not.toHaveBeenCalled();
    f.zone.status = 'active';
    f.dependencies.verifyRuntimeToken.mockRejectedValueOnce(new Error('missing purge permission'));
    await expect(
      applyPlatformDomain(
        f.client as unknown as PlatformCloudflareClient,
        f.manifest,
        f.target,
        { ...f.plan, zone: f.zone },
        f.dependencies,
      ),
    ).rejects.toThrow('missing purge');
    expect(f.client.createDnsRecord).not.toHaveBeenCalled();
    expect(f.client.putKvValue).not.toHaveBeenCalled();
  });
  it('retains disablement and rejects a different domain during a pending operation', async () => {
    const f = fixture();
    f.zone.status = 'active';
    const disabled = {
      ...f.manifest,
      status: 'disabled' as const,
      desiredState: 'disabled' as const,
    };
    const result = await applyPlatformDomain(
      f.client as unknown as PlatformCloudflareClient,
      disabled,
      f.target,
      { ...f.plan, zone: f.zone },
      f.dependencies,
    );
    expect(result.manifest.status).toBe('disabled');
    expect(result.manifest.desiredState).toBe('disabled');
    expect(() =>
      platformDomainTarget(
        { ...f.manifest, pendingDomain: f.target },
        'other.com',
        'other.com',
        false,
      ),
    ).toThrow('pending setup');
  });
});
