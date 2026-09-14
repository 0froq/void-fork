import { confirm, isCancel, log, note, outro } from '@clack/prompts';
import {
  createPlatformResourceOwnershipMarker,
  parsePlatformInstallationManifest,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  recordInstallationResource,
  setInstallationDesiredState,
  transitionInstallation,
  type InstallationResource,
  type PlatformInstallationManifest,
} from '@void/platform';
import type { PlatformArgs } from './platform-args.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import {
  createPlatformInstallationSecrets,
  installPlatform,
  REMOTE_INSTALLATION_MANIFEST_KEY,
  resolveBootstrapGitHubId,
} from './platform-installer.ts';
import { createPlatformInstallPlan, formatPlatformInstallPlan } from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  readInstallationRecoverySecrets,
  removeInstallationRecoverySecrets,
  removePlatformConnectionForInstallation,
  resolveInstallationManifest,
  writeInstallationManifest,
} from './platform-registry.ts';

type PlatformManagementClient = Pick<
  PlatformCloudflareClient,
  | 'deleteResource'
  | 'emptyR2Bucket'
  | 'findZone'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'listAiGateways'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'putKvValue'
  | 'removeRoutes'
  | 'setWorkerSubdomain'
>;

export type PlatformManagementDependencies = Readonly<{
  confirm?: (message: string, initialValue: boolean) => Promise<boolean>;
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

  const execute = async (currentManifest: PlatformInstallationManifest): Promise<void> => {
    const manifest = currentManifest;

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
    const bootstrapGitHubLogin =
      process.env.VOID_PLATFORM_ADMIN_GITHUB_LOGIN || recovery?.bootstrapGitHubLogin || '';
    const bootstrapGitHubId =
      process.env.VOID_PLATFORM_ADMIN_GITHUB_ID ||
      recovery?.bootstrapGitHubId ||
      (await resolveBootstrapGitHubId(bootstrapGitHubLogin));
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId,
      bootstrapGitHubLogin,
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
  };

  if (args.plan) {
    await execute(manifest);
    return;
  }
  const release = acquirePlatformLifecycleLock(
    manifest.account.id,
    manifest.deployment.installationSlug,
  );
  try {
    await execute(resolveInstallationManifest(args.selector));
  } finally {
    release();
  }
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
    `Remove routes and custom domains and disable workers.dev for:\n${[...workers].join('\n')}\n\nWorkers and all data remain installed.`,
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
  await verifyPlatformMutationOwnership(
    client,
    manifest,
    new Set([
      'routing-kv',
      'zone',
      ...manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.key),
    ]),
  );
  let next = setInstallationDesiredState(manifest, 'disabled', new Date().toISOString());
  writeInstallationManifest(next);
  next = transitionInstallation(next, 'disabling', new Date().toISOString());
  writeInstallationManifest(next);
  try {
    const zone = requireResource(next, 'zone');
    await client.removeRoutes(next.account.id, zone.id, workers);
    for (const worker of workers) {
      await client.setWorkerSubdomain(next.account.id, worker, false);
    }
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
  const retainData = !args.purgeData;
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
    ? 'Retain installer-owned storage, dispatch, AI logs, and Hyperdrive by default.'
    : args.purgeData
      ? 'Delete installer-owned storage (--purge-data); external PostgreSQL is never deleted.'
      : 'Retain installer-owned data; external PostgreSQL is never deleted.';
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

  const resourcesToDelete = new Set(
    manifest.resources
      .filter(
        (resource) =>
          shouldDeleteResource(resource, retainData, deleteZone) &&
          !(
            resource.kind === 'dns-record' &&
            !manifest.resources.some((entry) => entry.key === 'zone')
          ),
      )
      .map((resource) => resource.key),
  );
  const ownershipTargets = new Set([
    'routing-kv',
    'zone',
    ...manifest.resources
      .filter((resource) => resource.kind === 'worker')
      .map((resource) => resource.key),
    ...resourcesToDelete,
  ]);
  const missingResources = await verifyPlatformMutationOwnership(
    client,
    manifest,
    ownershipTargets,
    { allowDeletedRoutingCheckpoint: args.purgeData },
  );

  let next = transitionInstallation(manifest, 'uninstalling', new Date().toISOString());
  writeInstallationManifest(next);
  try {
    for (const key of missingResources) {
      const resource = requireResource(next, key);
      next = updateResourceState(
        next,
        key,
        resource.ownership === 'created' ? 'deleted' : 'retained',
      );
      writeInstallationManifest(next);
    }
    const workers = new Set(
      next.resources
        .filter((resource) => resource.kind === 'worker' && resource.state === 'ready')
        .map((resource) => resource.name),
    );
    const zone = next.resources.find((resource) => resource.key === 'zone');
    if (zone?.state === 'ready') {
      await client.removeRoutes(next.account.id, zone.id, workers);
    }
    const deletionPriority: Record<string, number> = {
      worker: 0,
      queue: 1,
      'ai-gateway': 2,
      'dns-record': 3,
      'dispatch-namespace': 4,
      hyperdrive: 5,
      'kv-namespace': 6,
      'r2-bucket': 7,
      zone: 8,
    };
    const resources = [...next.resources].sort(
      (left, right) =>
        resourceDeletionPriority(left, deletionPriority) -
        resourceDeletionPriority(right, deletionPriority),
    );
    for (const resource of resources) {
      if (resource.state !== 'ready') {
        continue;
      }
      if (!shouldDeleteResource(resource, retainData, deleteZone)) {
        next = updateResourceState(next, resource.key, 'retained');
        writeInstallationManifest(next);
        continue;
      }
      if (resource.kind === 'dns-record' && !zone) {
        next = updateResourceState(next, resource.key, 'retained');
        writeInstallationManifest(next);
        continue;
      }
      if (resource.kind === 'r2-bucket') {
        await client.emptyR2Bucket(
          next.account.id,
          resource.name,
          new Set([PLATFORM_R2_OWNERSHIP_MARKER_KEY]),
        );
      }
      await client.deleteResource(next.account.id, resource.kind, resource.id, zone?.id);
      next = updateResourceState(next, resource.key, 'deleted');
      writeInstallationManifest(next);
    }
    const completed = transitionInstallation(next, 'uninstalled', new Date().toISOString());
    await writeRemoteManifestIfPresent(client, completed);
    next = completed;
    writeInstallationManifest(completed);
    removeInstallationRecoverySecrets(next);
    removePlatformConnectionForInstallation(next.id);
    log.success(
      retainData
        ? `${next.deployment.displayName} was uninstalled; data resources were retained and recorded in ${next.id}.`
        : `${next.deployment.displayName} was uninstalled.`,
    );
  } catch (error) {
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    throw error;
  }
}

const DATA_RESOURCE_KINDS = new Set([
  'ai-gateway',
  'dispatch-namespace',
  'hyperdrive',
  'kv-namespace',
  'r2-bucket',
]);

function shouldDeleteResource(
  resource: InstallationResource,
  retainData: boolean,
  deleteZone: boolean,
): boolean {
  if (resource.state !== 'ready' || resource.ownership !== 'created') {
    return false;
  }
  if (resource.kind === 'zone') {
    return deleteZone;
  }
  return !(retainData && DATA_RESOURCE_KINDS.has(resource.kind));
}

function resourceDeletionPriority(
  resource: InstallationResource,
  priorities: Readonly<Record<string, number>>,
): number {
  // The routing namespace contains the authoritative ownership checkpoint.
  // Delete it last so interrupted purges can still prove every earlier mutation.
  return resource.key === 'routing-kv' ? 100 : (priorities[resource.kind] ?? 99);
}

async function verifyPlatformMutationOwnership(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  targetKeys: ReadonlySet<string>,
  options: { allowDeletedRoutingCheckpoint?: boolean } = {},
): Promise<ReadonlySet<string>> {
  const routing = requireResource(manifest, 'routing-kv');
  const rawRemote = await client.getKvValue(
    manifest.account.id,
    routing.id,
    REMOTE_INSTALLATION_MANIFEST_KEY,
  );
  if (rawRemote === null) {
    if (
      options.allowDeletedRoutingCheckpoint &&
      canResumeAfterRoutingCheckpointDeletion(manifest, targetKeys)
    ) {
      const namespaces = await client.listKvNamespaces(manifest.account.id);
      if (!namespaces.some((entry) => entry.id === routing.id)) {
        return new Set([routing.key]);
      }
    }
    throw ownershipError('the remote installation checkpoint is missing');
  }

  let remote: PlatformInstallationManifest;
  try {
    remote = parsePlatformInstallationManifest(JSON.parse(rawRemote) as unknown);
  } catch {
    throw ownershipError('the remote installation checkpoint is invalid');
  }
  if (
    remote.id !== manifest.id ||
    remote.ownershipNonce !== manifest.ownershipNonce ||
    remote.account.id !== manifest.account.id
  ) {
    throw ownershipError('the remote installation identity does not match this installation');
  }

  const targets = manifest.resources.filter(
    (resource) => targetKeys.has(resource.key) && resource.state === 'ready',
  );
  for (const resource of targets) {
    const proof = remote.resources.find((entry) => entry.key === resource.key);
    if (
      !proof ||
      proof.id !== resource.id ||
      proof.kind !== resource.kind ||
      proof.name !== resource.name ||
      proof.ownership !== resource.ownership
    ) {
      throw ownershipError(`the remote checkpoint does not own ${resource.kind} ${resource.name}`);
    }
  }

  const missing = new Set<string>();
  const accountId = manifest.account.id;
  const zone = manifest.resources.find((resource) => resource.key === 'zone');
  const inventory = await Promise.all([
    client.listAiGateways(accountId),
    client.listDispatchNamespaces(accountId),
    client.listHyperdriveConfigs(accountId),
    client.listKvNamespaces(accountId),
    client.listR2Buckets(accountId),
    client.listWorkerNames(accountId),
  ]);
  const [aiGateways, dispatchNamespaces, hyperdrives, kvNamespaces, r2Buckets, workerNames] =
    inventory;

  for (const resource of targets) {
    let exists = true;
    if (resource.kind === 'ai-gateway') {
      exists = hasNamedResource(aiGateways, resource);
    } else if (resource.kind === 'dispatch-namespace') {
      exists = hasNamedResource(dispatchNamespaces, resource);
    } else if (resource.kind === 'hyperdrive') {
      exists = hasNamedResource(hyperdrives, resource);
    } else if (resource.kind === 'kv-namespace') {
      exists = hasNamedResource(kvNamespaces, resource);
    } else if (resource.kind === 'queue') {
      exists = hasNamedResource(await client.listQueues(accountId, resource.name), resource);
    } else if (resource.kind === 'zone') {
      const current = await client.findZone(accountId, resource.name);
      exists = current?.id === resource.id;
    } else if (resource.kind === 'dns-record') {
      if (!zone) {
        exists = false;
      } else {
        exists = hasNamedResource(await client.listDnsRecords(zone.id, resource.name), resource);
      }
    } else if (resource.kind === 'worker') {
      exists = workerNames.includes(resource.name);
      if (exists) {
        const bindings = await client.getWorkerPlainTextBindings(accountId, resource.name);
        verifyResourceMarker(bindings.PLATFORM_OWNERSHIP_MARKER, manifest, resource);
      }
    } else if (resource.kind === 'r2-bucket') {
      exists = hasNamedResource(r2Buckets, resource);
      if (exists) {
        verifyResourceMarker(
          await client.getR2Object(accountId, resource.name, PLATFORM_R2_OWNERSHIP_MARKER_KEY),
          manifest,
          resource,
        );
      }
    } else {
      throw ownershipError(`live ownership checks do not support ${resource.kind}`);
    }
    if (!exists) {
      missing.add(resource.key);
    }
  }
  return missing;
}

function hasNamedResource(
  entries: ReadonlyArray<{ id: string; name: string }>,
  resource: InstallationResource,
): boolean {
  return entries.some((entry) => entry.id === resource.id && entry.name === resource.name);
}

function verifyResourceMarker(
  value: string | null | undefined,
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): void {
  if (!value) {
    throw ownershipError(`${resource.kind} ${resource.name} has no ownership marker`);
  }
  let actual;
  try {
    actual = parsePlatformResourceOwnershipMarker(JSON.parse(value) as unknown);
  } catch {
    throw ownershipError(`${resource.kind} ${resource.name} has an invalid ownership marker`);
  }
  const expected = createPlatformResourceOwnershipMarker({
    accountId: manifest.account.id,
    installationId: manifest.id,
    ownershipNonce: manifest.ownershipNonce,
    resourceId: resource.id,
    resourceKey: resource.key,
    resourceKind: resource.kind,
    resourceName: resource.name,
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw ownershipError(`${resource.kind} ${resource.name} belongs to another installation`);
  }
}

function canResumeAfterRoutingCheckpointDeletion(
  manifest: PlatformInstallationManifest,
  targetKeys: ReadonlySet<string>,
): boolean {
  if (manifest.status !== 'failed' && manifest.status !== 'uninstalling') {
    return false;
  }
  return manifest.resources.every(
    (resource) =>
      resource.key === 'routing-kv' || !targetKeys.has(resource.key) || resource.state !== 'ready',
  );
}

function ownershipError(reason: string): Error {
  return new Error(
    `platform: Refusing to change Cloudflare resources because ${reason}. Run \`void platform repair\` to restore ownership proofs before retrying.`,
  );
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
    (resource) => resource.key === 'routing-kv' && resource.state !== 'deleted',
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

async function promptForConfirmation(message: string, initialValue: boolean): Promise<boolean> {
  const answer = await confirm({ message, initialValue });
  if (isCancel(answer) || typeof answer === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return answer;
}
