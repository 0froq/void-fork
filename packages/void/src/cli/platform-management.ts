import { confirm, isCancel, log, note, outro } from '@clack/prompts';
import {
  recordInstallationResource,
  transitionInstallation,
  type PlatformInstallationManifest,
} from '@void/platform';
import type { PlatformArgs } from './platform-args.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import {
  createPlatformInstallationSecrets,
  installPlatform,
  REMOTE_INSTALLATION_MANIFEST_KEY,
} from './platform-installer.ts';
import { createPlatformInstallPlan, formatPlatformInstallPlan } from './platform-plan.ts';
import {
  readInstallationRecoverySecrets,
  removeInstallationRecoverySecrets,
  removePlatformConnectionForInstallation,
  resolveInstallationManifest,
  writeInstallationManifest,
} from './platform-registry.ts';

type PlatformManagementClient = Pick<
  PlatformCloudflareClient,
  'deleteKvValue' | 'deleteResource' | 'putKvValue' | 'removeRoutes'
>;

export type PlatformManagementDependencies = Readonly<{
  confirm?: (message: string, initialValue: boolean) => Promise<boolean>;
  countProjects?: (databaseUrl: string) => Promise<number>;
  interactive?: boolean;
}>;

export async function runInstalledPlatformCommand(args: PlatformArgs): Promise<void> {
  if (
    args.subcommand !== 'upgrade' &&
    args.subcommand !== 'repair' &&
    args.subcommand !== 'disable' &&
    args.subcommand !== 'uninstall'
  ) {
    throw new Error(`platform: Unsupported lifecycle command ${args.subcommand}.`);
  }
  const manifest = resolveInstallationManifest(args.selector);
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
  if (!token) {
    throw new Error('platform: Export CLOUDFLARE_API_TOKEN to manage an installed platform.');
  }
  const client = new PlatformCloudflareClient(token);

  if (args.subcommand === 'disable') {
    await disablePlatform(client, manifest, args.plan);
    return;
  }
  if (args.subcommand === 'uninstall') {
    await uninstallPlatform(client, manifest, args);
    return;
  }

  const deployment = manifest.deployment;
  const plan = await createPlatformInstallPlan(
    client,
    {
      accountId: manifest.account.id,
      applicationDomain: deployment.application.baseDomain,
      controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
      dedicatedZone: deployment.application.dedicatedZone,
      displayName: deployment.displayName,
      installationSlug: deployment.installationSlug,
      zoneName: deployment.application.zoneName,
    },
    manifest,
    { repairMissing: args.subcommand === 'repair' },
  );
  note(
    formatPlatformInstallPlan(plan),
    args.subcommand === 'upgrade' ? 'Upgrade plan' : 'Repair plan',
  );
  if (args.plan) {
    outro('No Cloudflare or local installation state was changed.');
    return;
  }
  const recovery = readInstallationRecoverySecrets(manifest);
  const secrets = createPlatformInstallationSecrets({
    cloudflareApiToken: token,
    checkpoint: recovery,
    databaseUrl: process.env.VOID_PLATFORM_DATABASE_URL || process.env.DATABASE_URL || '',
    githubClientId: process.env.VOID_PLATFORM_GITHUB_CLIENT_ID || '',
    githubClientSecret: process.env.VOID_PLATFORM_GITHUB_CLIENT_SECRET || '',
    r2AccessKeyId: process.env.VOID_PLATFORM_R2_ACCESS_KEY_ID || '',
    r2SecretAccessKey: process.env.VOID_PLATFORM_R2_SECRET_ACCESS_KEY || '',
  });
  const result = await installPlatform(plan, secrets, manifest, { client });
  if (result.waitingForDns) {
    note(
      `Wait for ${deployment.application.zoneName} to become active, then rerun this command.`,
      'Waiting for nameservers',
    );
    return;
  }
  log.success(`${deployment.displayName} is healthy at ${plan.apiUrl}.`);
}

export async function disablePlatform(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  planOnly: boolean,
): Promise<void> {
  const workers = new Set(
    manifest.resources
      .filter((resource) => resource.kind === 'worker' && resource.state === 'ready')
      .map((resource) => resource.name),
  );
  note(
    `Remove routes and custom domains for:\n${[...workers].join('\n')}\n\nWorkers and all data remain installed.`,
    'Disable plan',
  );
  if (planOnly) {
    outro('No Cloudflare or local installation state was changed.');
    return;
  }
  if (manifest.status === 'disabled') {
    log.info(`${manifest.deployment.displayName} is already disabled.`);
    return;
  }
  let next = transitionInstallation(manifest, 'disabling', new Date().toISOString());
  writeInstallationManifest(next);
  try {
    const zone = requireResource(next, 'zone');
    await client.removeRoutes(next.account.id, zone.id, workers);
    next = transitionInstallation(next, 'disabled', new Date().toISOString());
    writeInstallationManifest(next);
    await writeRemoteManifestIfPresent(client, next);
    log.success(`${next.deployment.displayName} is disabled. Its data was not changed.`);
  } catch (error) {
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    throw error;
  }
}

export async function uninstallPlatform(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  args: Extract<PlatformArgs, { subcommand: 'uninstall' }>,
  dependencies: PlatformManagementDependencies = {},
): Promise<void> {
  const recovery = readInstallationRecoverySecrets(manifest);
  const databaseUrl =
    recovery?.databaseUrl ||
    process.env.VOID_PLATFORM_DATABASE_URL ||
    process.env.DATABASE_URL ||
    '';
  if (!databaseUrl) {
    throw new Error(
      'platform: DATABASE_URL recovery material is unavailable. Set VOID_PLATFORM_DATABASE_URL so uninstall can determine whether app data must be retained.',
    );
  }
  const appCount = await (dependencies.countProjects ?? countProjects)(databaseUrl);
  const retainData = appCount > 0 && !args.purgeData;
  const createdZone = manifest.resources.find(
    (resource) => resource.key === 'zone' && resource.ownership === 'created',
  );
  let deleteZone = args.deleteZone ?? false;
  const interactive = dependencies.interactive ?? process.stdin.isTTY;
  const confirmAction = dependencies.confirm ?? promptForConfirmation;
  if (createdZone && args.deleteZone === null && !args.plan && interactive) {
    deleteZone = await confirmAction(
      `Delete the installer-created Cloudflare zone ${createdZone.name}?`,
      false,
    );
  }
  const dataMessage = retainData
    ? `Retain storage and Hyperdrive because PostgreSQL contains ${appCount} app(s).`
    : args.purgeData
      ? 'Delete installer-owned storage (--purge-data); external PostgreSQL is never deleted.'
      : 'Delete empty installer-owned storage; external PostgreSQL is never deleted.';
  note(
    `Disable all platform routes.\nDelete installer-owned Workers and Queues.\n${dataMessage}\n${
      createdZone
        ? deleteZone
          ? `Delete zone ${createdZone.name}.`
          : `Keep zone ${createdZone.name}.`
        : 'Never delete the adopted application zone.'
    }`,
    'Uninstall plan',
  );
  if (args.plan) {
    outro('No Cloudflare or local installation state was changed.');
    return;
  }
  if (interactive) {
    const proceed = await confirmAction(
      args.purgeData
        ? 'Permanently purge installer-owned platform data?'
        : 'Uninstall this platform?',
      false,
    );
    if (!proceed) {
      outro('No changes made.');
      return;
    }
  }

  let next = transitionInstallation(manifest, 'uninstalling', new Date().toISOString());
  writeInstallationManifest(next);
  try {
    const workers = new Set(
      next.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.name),
    );
    const zone = requireResource(next, 'zone');
    if (zone.state === 'ready') {
      await client.removeRoutes(next.account.id, zone.id, workers);
    }
    const dataKinds = new Set([
      'ai-gateway',
      'dispatch-namespace',
      'hyperdrive',
      'kv-namespace',
      'r2-bucket',
    ]);
    const deletionPriority: Record<string, number> = {
      worker: 0,
      queue: 1,
      'ai-gateway': 2,
      'dispatch-namespace': 3,
      hyperdrive: 4,
      'kv-namespace': 5,
      'r2-bucket': 6,
      zone: 7,
    };
    const resources = [...next.resources].sort(
      (left, right) => (deletionPriority[left.kind] ?? 99) - (deletionPriority[right.kind] ?? 99),
    );
    for (const resource of resources) {
      if (resource.state !== 'ready') {
        continue;
      }
      if (resource.ownership !== 'created') {
        next = updateResourceState(next, resource.key, 'retained');
        writeInstallationManifest(next);
        continue;
      }
      if (resource.kind === 'zone' && !deleteZone) {
        next = updateResourceState(next, resource.key, 'retained');
        writeInstallationManifest(next);
        continue;
      }
      if (retainData && dataKinds.has(resource.kind)) {
        next = updateResourceState(next, resource.key, 'retained');
        writeInstallationManifest(next);
        continue;
      }
      await client.deleteResource(next.account.id, resource.kind, resource.id);
      next = updateResourceState(next, resource.key, 'deleted');
      writeInstallationManifest(next);
    }
    const retainedRouting = next.resources.find(
      (resource) => resource.key === 'routing-kv' && resource.state === 'retained',
    );
    if (retainedRouting) {
      await client.deleteKvValue(
        next.account.id,
        retainedRouting.id,
        REMOTE_INSTALLATION_MANIFEST_KEY,
      );
    }
    next = transitionInstallation(next, 'uninstalled', new Date().toISOString());
    writeInstallationManifest(next);
    removeInstallationRecoverySecrets(next);
    removePlatformConnectionForInstallation(next.id);
    log.success(
      retainData
        ? `${next.deployment.displayName} was uninstalled; app data was retained and recorded in ${next.id}.`
        : `${next.deployment.displayName} was uninstalled.`,
    );
  } catch (error) {
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    throw error;
  }
}

function requireResource(manifest: PlatformInstallationManifest, key: string) {
  const resource = manifest.resources.find((entry) => entry.key === key);
  if (!resource) {
    throw new Error(`platform: Installation manifest is missing ${key}.`);
  }
  return resource;
}

function updateResourceState(
  manifest: PlatformInstallationManifest,
  key: string,
  state: 'deleted' | 'retained',
): PlatformInstallationManifest {
  const resource = requireResource(manifest, key);
  return recordInstallationResource(manifest, { ...resource, state }, new Date().toISOString());
}

async function writeRemoteManifestIfPresent(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
): Promise<void> {
  const routing = manifest.resources.find(
    (resource) => resource.key === 'routing-kv' && resource.state === 'ready',
  );
  if (routing) {
    await client.putKvValue(
      manifest.account.id,
      routing.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
      JSON.stringify(manifest),
    );
  }
}

async function countProjects(databaseUrl: string): Promise<number> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM projects',
    );
    const count = Number(result.rows[0]?.count ?? '');
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('platform: PostgreSQL returned an invalid project count.');
    }
    return count;
  } finally {
    await pool.end();
  }
}

async function promptForConfirmation(message: string, initialValue: boolean): Promise<boolean> {
  const answer = await confirm({ message, initialValue });
  if (isCancel(answer) || typeof answer === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return answer;
}
