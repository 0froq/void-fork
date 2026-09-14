import {
  parsePlatformInstallationManifest,
  setInstallationEndpoints,
  type PlatformInstallationManifest,
} from '@void/platform';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';
import { REMOTE_INSTALLATION_MANIFEST_KEY } from './platform-installer.ts';
import { verifyPlatformInstallationOwnership } from './platform-management.ts';
import { createPlatformInstallPlan } from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  listInstallationManifests,
  savePlatformConnection,
  writeInstallationManifest,
} from './platform-registry.ts';

type RecoveryClient = Pick<
  PlatformCloudflareClient,
  | 'findZone'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'getWorkersSubdomain'
  | 'listAccounts'
  | 'listAiGateways'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'verifyToken'
>;

export async function recoverPlatformInstallations(
  client: RecoveryClient,
  accountId: string,
  verifyEndpoint: (
    manifest: PlatformInstallationManifest,
  ) => Promise<void> = verifyInstallationEndpoint,
): Promise<ReadonlyArray<PlatformInstallationManifest>> {
  await client.verifyToken();
  const accounts = await client.listAccounts();
  if (!accounts.some((account) => account.id === accountId)) {
    throw new Error(`platform: Cloudflare account ${JSON.stringify(accountId)} is unavailable.`);
  }
  const namespaces = (await client.listKvNamespaces(accountId)).filter((namespace) =>
    /^void-[a-z0-9-]+-routing$/.test(namespace.name),
  );
  const recovered: Array<PlatformInstallationManifest> = [];
  for (const namespace of namespaces) {
    const value = await client.getKvValue(
      accountId,
      namespace.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
    );
    if (value === null) {
      continue;
    }
    let manifest: PlatformInstallationManifest;
    try {
      manifest = parsePlatformInstallationManifest(JSON.parse(value) as unknown);
    } catch (error) {
      throw new Error(
        `platform: Routing namespace ${namespace.name} contains invalid Void ownership metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const routing = manifest.resources.find((resource) => resource.key === 'routing-kv');
    if (
      manifest.account.id !== accountId ||
      routing?.kind !== 'kv-namespace' ||
      routing.id !== namespace.id ||
      routing.name !== namespace.name ||
      routing.ownership !== 'created' ||
      routing.state !== 'ready'
    ) {
      throw new Error(
        `platform: Routing namespace ${namespace.name} does not match its ownership manifest.`,
      );
    }
    if (manifest.status === 'uninstalled' || !manifest.endpoints.apiUrl) {
      continue;
    }
    const deployment = manifest.deployment;
    const plan = await createPlatformInstallPlan(
      client,
      {
        accountId,
        applicationDomain: deployment.application.baseDomain,
        controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
        dedicatedZone: deployment.application.dedicatedZone,
        displayName: deployment.displayName,
        installationSlug: deployment.installationSlug,
        zoneName: deployment.application.zoneName,
      },
      manifest,
    );
    if (manifest.endpoints.apiUrl !== plan.apiUrl) {
      throw new Error(`platform: Installation ${manifest.id} has inconsistent API metadata.`);
    }
    if (manifest.endpoints.proxyUrl === null) {
      manifest = setInstallationEndpoints(
        manifest,
        { ...manifest.endpoints, proxyUrl: plan.proxyUrl },
        manifest.updatedAt,
      );
    } else if (manifest.endpoints.proxyUrl !== plan.proxyUrl) {
      throw new Error(`platform: Installation ${manifest.id} has inconsistent proxy metadata.`);
    }
    await verifyPlatformInstallationOwnership(client, manifest);
    if (manifest.desiredState === 'enabled' && manifest.status !== 'disabled') {
      await verifyEndpoint(manifest);
    }
    recovered.push(manifest);
  }

  for (const manifest of recovered) {
    const release = acquirePlatformLifecycleLock(
      manifest.account.id,
      manifest.deployment.installationSlug,
    );
    try {
      const collision = listInstallationManifests().find((entry) => entry.id === manifest.id);
      if (
        collision &&
        (collision.account.id !== manifest.account.id ||
          collision.ownershipNonce !== manifest.ownershipNonce)
      ) {
        throw new Error(`platform: Local installation ${manifest.id} has conflicting ownership.`);
      }
      if (collision && JSON.stringify(collision) !== JSON.stringify(manifest)) {
        throw new Error(
          `platform: Local installation ${manifest.id} differs from its remote checkpoint. Resolve or remove the local record before discovery; it was not overwritten.`,
        );
      }
      if (!collision) {
        writeInstallationManifest(manifest);
      }
      savePlatformConnection({
        accountId: manifest.account.id,
        apiUrl: manifest.endpoints.apiUrl!,
        applicationDomain: manifest.deployment.application.baseDomain,
        displayName: manifest.deployment.displayName,
        installationId: manifest.id,
        kind: 'installed',
        proxyUrl: manifest.endpoints.proxyUrl!,
      });
    } finally {
      release();
    }
  }
  return recovered;
}

async function verifyInstallationEndpoint(manifest: PlatformInstallationManifest): Promise<void> {
  const response = await fetch(`${manifest.endpoints.apiUrl}/.well-known/void-platform`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `platform: Installation ${manifest.id} is not reachable (HTTP ${response.status}).`,
    );
  }
  const value = (await response.json()) as { installationId?: unknown };
  if (value.installationId !== manifest.id) {
    throw new Error(`platform: Installation ${manifest.id} endpoint identity does not match.`);
  }
}
