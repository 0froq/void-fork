import { createHash } from 'node:crypto';
import {
  createApplicationRoutes,
  recordInstallationResource,
  type PlatformDeploymentManifest,
  type PlatformInstallationManifest,
} from '@void/platform';
import type {
  CloudflareWorkerDomain,
  CloudflareWorkerRoute,
  PlatformManagedWorkerTraffic,
  PlatformTrackedWorkerTraffic,
} from './platform-cloudflare.ts';

export function platformManagedWorkerTraffic(
  deployment: PlatformDeploymentManifest,
  workers?: ReadonlySet<string>,
): PlatformManagedWorkerTraffic {
  const includes = (worker: string) => workers === undefined || workers.has(worker);
  const names = deployment.resources;
  const customDomains: Array<{ hostname: string; service: string }> = [];
  if (deployment.controlPlane.apiHostname && includes(names.apiWorker)) {
    customDomains.push({
      hostname: deployment.controlPlane.apiHostname,
      service: names.apiWorker,
    });
  }
  if (deployment.controlPlane.proxyHostname && includes(names.proxyWorker)) {
    customDomains.push({
      hostname: deployment.controlPlane.proxyHostname,
      service: names.proxyWorker,
    });
  }
  return {
    customDomains,
    routes: includes(names.dispatchWorker)
      ? createApplicationRoutes(deployment.application).map((route) => ({
          pattern: route.pattern,
          script: names.dispatchWorker,
        }))
      : [],
  };
}

function trafficConfigHash(kind: 'worker-custom-domain' | 'worker-route', value: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, value })).digest('hex');
}

export function trackedPlatformWorkerTraffic(
  manifest: PlatformInstallationManifest,
  workers?: ReadonlySet<string>,
): PlatformTrackedWorkerTraffic {
  const desired = platformManagedWorkerTraffic(manifest.deployment, workers);
  const resources = manifest.resources.filter((resource) => resource.state === 'ready');
  return {
    customDomains: desired.customDomains.flatMap((target) => {
      const configHash = trafficConfigHash('worker-custom-domain', target);
      return resources
        .filter(
          (resource) =>
            resource.kind === 'worker-custom-domain' &&
            resource.name === target.hostname &&
            resource.configHash === configHash,
        )
        .map((resource) => ({ ...target, id: resource.id }));
    }),
    routes: desired.routes.flatMap((target) => {
      const configHash = trafficConfigHash('worker-route', target);
      return resources
        .filter(
          (resource) =>
            resource.kind === 'worker-route' &&
            resource.name === target.pattern &&
            resource.configHash === configHash,
        )
        .map((resource) => ({ ...target, id: resource.id }));
    }),
  };
}

export function recordPlatformWorkerTraffic(
  manifest: PlatformInstallationManifest,
  workerName: string,
  inventory: Readonly<{
    customDomains: ReadonlyArray<CloudflareWorkerDomain>;
    routes: ReadonlyArray<CloudflareWorkerRoute>;
  }>,
  updatedAt: string,
): PlatformInstallationManifest {
  const desired = platformManagedWorkerTraffic(manifest.deployment, new Set([workerName]));
  let next = manifest;
  for (const target of desired.routes) {
    const matches = inventory.routes.filter(
      (route) => route.pattern === target.pattern && route.script === target.script,
    );
    if (matches.length !== 1) {
      throw new Error(
        `platform: Expected exactly one published Worker route for ${JSON.stringify(target.pattern)} and ${JSON.stringify(target.script)}.`,
      );
    }
    const route = matches[0]!;
    next = recordInstallationResource(
      next,
      {
        configHash: trafficConfigHash('worker-route', target),
        id: route.id,
        key: `worker-route:${route.id}`,
        kind: 'worker-route',
        name: route.pattern,
        ownership: 'created',
        state: 'ready',
      },
      updatedAt,
    );
  }
  for (const target of desired.customDomains) {
    const matches = inventory.customDomains.filter(
      (domain) => domain.hostname === target.hostname && domain.service === target.service,
    );
    if (matches.length !== 1) {
      throw new Error(
        `platform: Expected exactly one published Worker custom domain for ${JSON.stringify(target.hostname)} and ${JSON.stringify(target.service)}.`,
      );
    }
    const domain = matches[0]!;
    next = recordInstallationResource(
      next,
      {
        configHash: trafficConfigHash('worker-custom-domain', target),
        id: domain.id,
        key: `worker-custom-domain:${domain.id}`,
        kind: 'worker-custom-domain',
        name: domain.hostname,
        ownership: 'created',
        state: 'ready',
      },
      updatedAt,
    );
  }
  return next;
}
