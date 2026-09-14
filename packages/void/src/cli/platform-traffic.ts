import { createApplicationRoutes, type PlatformDeploymentManifest } from '@void/platform';
import type { PlatformManagedWorkerTraffic } from './platform-cloudflare.ts';

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
