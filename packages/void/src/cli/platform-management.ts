import { createHash } from 'node:crypto';
import { confirm, isCancel, log, note, outro } from '@clack/prompts';
import {
  createPlatformResourceOwnershipMarker,
  parsePlatformInstallationManifest,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  transitionInstallation,
  type InstallationResource,
  type PlatformInstallationManifest,
} from '@void/platform';
import type { PlatformArgs } from './platform-args.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  createPlatformInstallationSecrets,
  installPlatform,
  REMOTE_INSTALLATION_MANIFEST_KEY,
  resolveBootstrapGitHubId,
} from './platform-installer.ts';
import {
  createPlatformInstallPlan,
  formatPlatformInstallPlan,
  platformAdoptionIntentHash,
  platformProvisionIntentHash,
  revalidatePlatformInstallAction,
} from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  readInstallationRecoverySecrets,
  removeInstallationRecoverySecrets,
  removePlatformConnectionForInstallation,
  resolveInstallationManifest,
  writeInstallationManifest,
} from './platform-registry.ts';

export type PlatformManagementClient = Pick<
  PlatformCloudflareClient,
  | 'deleteResource'
  | 'deleteR2Object'
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

export type PlatformOwnershipClient = Pick<
  PlatformManagementClient,
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
>;

export async function verifyPlatformInstallationOwnership(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
  options: {
    allowMissingRoutingCheckpoint?: boolean;
    allowUninitializedRoutingCheckpoint?: boolean;
  } = {},
): Promise<void> {
  const ready = manifest.resources.filter(
    (resource) => resource.state === 'ready' && isOwnershipVerifiableKind(resource.kind),
  );
  const routing = ready.find((resource) => resource.key === 'routing-kv');
  if (!routing) {
    const unsafe = ready.filter((resource) => resource.kind !== 'zone');
    if (unsafe.length > 0) {
      throw ownershipError(
        `the remote installation checkpoint is missing for ${unsafe[0]!.kind} ${unsafe[0]!.name}`,
      );
    }
    const zone = ready.find((resource) => resource.kind === 'zone');
    if (zone) {
      const current = await client.findZone(manifest.account.id, zone.name);
      if (current?.id !== zone.id) {
        throw ownershipError(`zone ${zone.name} was replaced`);
      }
    }
    return;
  }
  await verifyPlatformMutationOwnership(
    client,
    manifest,
    new Set(ready.map((resource) => resource.key)),
    options,
  );
}

export type PlatformManagementDependencies = Readonly<{
  checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>;
  confirm?: (message: string, initialValue: boolean) => Promise<boolean>;
  interactive?: boolean;
}>;

export function selectAuthoritativePlatformManifest(
  local: PlatformInstallationManifest,
  authoritative: PlatformInstallationManifest | null | undefined,
): PlatformInstallationManifest {
  if (!authoritative) {
    return local;
  }
  if (
    authoritative.id !== local.id ||
    authoritative.ownershipNonce !== local.ownershipNonce ||
    authoritative.account.id !== local.account.id
  ) {
    throw new Error('platform: The authoritative lifecycle state belongs to another installation.');
  }
  return authoritative;
}

export async function runInstalledPlatformCommand(args: PlatformArgs): Promise<void> {
  if (
    args.subcommand !== 'upgrade' &&
    args.subcommand !== 'repair' &&
    args.subcommand !== 'disable' &&
    args.subcommand !== 'enable' &&
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

  const execute = async (
    currentManifest: PlatformInstallationManifest,
    databaseCheckpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
    databaseCheckpointExists = false,
  ): Promise<void> => {
    const manifest = currentManifest;

    if (args.subcommand === 'disable') {
      await disablePlatform(client, manifest, args.plan, { checkpoint: databaseCheckpoint });
      return;
    }
    if (args.subcommand === 'uninstall') {
      await uninstallPlatform(client, manifest, args, { checkpoint: databaseCheckpoint });
      return;
    }
    if (
      args.subcommand === 'enable' &&
      manifest.desiredState === 'enabled' &&
      manifest.status === 'installed'
    ) {
      log.info(`${manifest.deployment.displayName} is already enabled.`);
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
      args.subcommand === 'upgrade'
        ? 'Upgrade plan'
        : args.subcommand === 'enable'
          ? 'Enable plan'
          : 'Repair plan',
    );
    if (args.plan) {
      outro('No Cloudflare or local installation state was changed.');
      return;
    }
    const repairingMissingRoutingCheckpoint =
      args.subcommand === 'repair' &&
      plan.actions.some(
        (action) => action.key === 'routing-kv' && action.action === 'create' && action.id === null,
      );
    await verifyPlatformMutationOwnership(
      client,
      manifest,
      new Set(
        manifest.resources
          .filter((resource) => isOwnershipVerifiableKind(resource.kind))
          .map((resource) => resource.key),
      ),
      {
        allowMissingRoutingCheckpoint: repairingMissingRoutingCheckpoint,
        allowUninitializedRoutingCheckpoint:
          args.subcommand === 'repair' && databaseCheckpointExists,
      },
    );
    const installation =
      args.subcommand === 'enable'
        ? setInstallationDesiredState(manifest, 'enabled', new Date().toISOString())
        : manifest;
    if (installation !== manifest) {
      writeInstallationManifest(installation);
    }
    const recovery = readInstallationRecoverySecrets(installation);
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
    const result = await installPlatform(plan, secrets, installation, {
      // runInstalledPlatformCommand holds the database session lock across the
      // entire replan and mutation sequence.
      acquireDatabaseLifecycleLock: async () =>
        Object.assign(async () => {}, { checkpoint: databaseCheckpoint }),
      client,
      revalidateBeforeWorkerDeploy: (manifest, action) =>
        revalidatePlatformInstallAction(client, plan, manifest, action, {
          repairMissing: args.subcommand === 'repair',
        }),
    });
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
    const current = resolveInstallationManifest(args.selector);
    const recovery = readInstallationRecoverySecrets(current);
    const databaseUrl =
      process.env.VOID_PLATFORM_DATABASE_URL || process.env.DATABASE_URL || recovery?.databaseUrl;
    if (!databaseUrl) {
      throw new Error(
        'platform: DATABASE_URL is required to safely serialize lifecycle changes across hosts.',
      );
    }
    const releaseDatabase = await acquirePlatformDatabaseLifecycleLock(
      databaseUrl,
      current.id,
      current.ownershipNonce,
    );
    try {
      const authoritative = releaseDatabase.authoritativeManifest;
      const databaseCheckpointExists = authoritative !== null && authoritative !== undefined;
      const currentManifest = selectAuthoritativePlatformManifest(current, authoritative);
      if (authoritative && JSON.stringify(authoritative) !== JSON.stringify(current)) {
        writeInstallationManifest(authoritative);
      }
      if (!authoritative) {
        await releaseDatabase.checkpoint?.(currentManifest);
      }
      await execute(currentManifest, releaseDatabase.checkpoint, databaseCheckpointExists);
    } finally {
      await releaseDatabase();
    }
  } finally {
    release();
  }
}

export async function disablePlatform(
  client: PlatformManagementClient,
  initialManifest: PlatformInstallationManifest,
  planOnly: boolean,
  dependencies: PlatformManagementDependencies = {},
): Promise<void> {
  const reconciled = await recoverDurablyMarkedProvisionIntents(client, initialManifest);
  const writeLifecycleCheckpoint = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeLifecycleCheckpointWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  const writeRemoteManifestIfPresent = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeRemoteManifestIfPresentWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  const workers = new Set(
    reconciled.resources
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
  const manifest = reconciled;
  if (manifest !== initialManifest) {
    writeInstallationManifest(manifest);
  }
  const alreadyDisabled = manifest.status === 'disabled';
  const missing = await verifyPlatformMutationOwnership(
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
  if (!alreadyDisabled) {
    next = transitionInstallation(next, 'disabling', new Date().toISOString());
    writeInstallationManifest(next);
  }
  try {
    await writeRemoteManifestIfPresent(client, next);
    const zone = requireResource(next, 'zone');
    const trafficGeneration = currentTrafficGeneration(next);
    await client.removeRoutes(next.account.id, missing.has(zone.key) ? null : zone.id, workers);
    if (!hasLifecycleStep(next, `disable:${trafficGeneration}:routes`)) {
      next = recordLifecycleStep(next, `disable:${trafficGeneration}:routes`);
    }
    await writeLifecycleCheckpoint(client, next);
    for (const worker of workers) {
      const step = `disable:${trafficGeneration}:workers.dev:${worker}`;
      const resource = next.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === worker,
      )!;
      if (!missing.has(resource.key)) {
        await client.setWorkerSubdomain(next.account.id, worker, false);
      }
      if (!hasLifecycleStep(next, step)) {
        next = recordLifecycleStep(next, step);
      }
      await writeLifecycleCheckpoint(client, next);
    }
    next = transitionInstallation(next, 'disabled', new Date().toISOString());
    await writeLifecycleCheckpoint(client, next);
    log.success(`${next.deployment.displayName} is disabled. Its data was not changed.`);
  } catch (error) {
    next = transitionInstallation(next, 'failed', new Date().toISOString());
    writeInstallationManifest(next);
    await writeRemoteManifestIfPresent(client, next).catch(() => {});
    throw error;
  }
}

export async function uninstallPlatform(
  client: PlatformManagementClient,
  initialManifest: PlatformInstallationManifest,
  args: Extract<PlatformArgs, { subcommand: 'uninstall' }>,
  dependencies: PlatformManagementDependencies = {},
): Promise<void> {
  const reconciled = await recoverDurablyMarkedProvisionIntents(client, initialManifest);
  const manifest = reconciled;
  const writeLifecycleCheckpoint = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeLifecycleCheckpointWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  const writeRemoteManifestIfPresent = (
    checkpointClient: PlatformManagementClient,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeRemoteManifestIfPresentWithoutDatabase(
      checkpointClient,
      checkpointManifest,
      dependencies.checkpoint,
    );
  const retainData = !args.purgeData;
  const hasRoutingCheckpoint = manifest.resources.some(
    (resource) => resource.key === 'routing-kv' && resource.state === 'ready',
  );
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
      ? 'Delete safely identifiable installer-owned storage (--purge-data); retain AI Gateway and external PostgreSQL.'
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
  if (manifest !== initialManifest) {
    writeInstallationManifest(manifest);
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
          (hasRoutingCheckpoint || resource.kind === 'zone') &&
          !(
            resource.kind === 'dns-record' &&
            !manifest.resources.some((entry) => entry.key === 'zone')
          ),
      )
      .map((resource) => resource.key),
  );
  const ownershipTargets = new Set([
    ...(hasRoutingCheckpoint ? ['routing-kv'] : []),
    'zone',
    ...manifest.resources
      .filter((resource) => resource.kind === 'worker')
      .map((resource) => resource.key),
    ...resourcesToDelete,
  ]);
  let missingResources: ReadonlySet<string>;
  if (hasRoutingCheckpoint) {
    missingResources = await verifyPlatformMutationOwnership(client, manifest, ownershipTargets, {
      allowDeletedRoutingCheckpoint: args.purgeData,
    });
  } else {
    await verifyPlatformInstallationOwnership(client, manifest);
    missingResources = new Set();
  }

  let next = transitionInstallation(manifest, 'uninstalling', new Date().toISOString());
  writeInstallationManifest(next);
  try {
    await writeRemoteManifestIfPresent(client, next);
    for (const key of missingResources) {
      const resource = requireResource(next, key);
      next = updateResourceState(
        next,
        key,
        resource.ownership === 'created' ? 'deleted' : 'retained',
      );
      await writeLifecycleCheckpoint(client, next);
    }
    const workers = new Set(
      next.resources
        .filter((resource) => resource.kind === 'worker' && resource.state === 'ready')
        .map((resource) => resource.name),
    );
    const zone = next.resources.find((resource) => resource.key === 'zone');
    if (zone?.state === 'ready') {
      for (const worker of next.resources.filter(
        (resource) =>
          resource.kind === 'worker' && resource.state === 'ready' && workers.has(resource.name),
      )) {
        const missing = await verifyPlatformMutationOwnership(
          client,
          next,
          new Set(['routing-kv', 'zone', worker.key]),
        );
        if (!missing.has(worker.key)) {
          await client.removeRoutes(next.account.id, zone.id, new Set([worker.name]));
          next = recordLifecycleStep(next, `uninstall:routes:${worker.key}`);
          await writeLifecycleCheckpoint(client, next);
        }
      }
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
      if (!hasRoutingCheckpoint && resource.kind !== 'zone') {
        next = updateResourceState(next, resource.key, 'retained');
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      if (!shouldDeleteResource(resource, retainData, deleteZone)) {
        next = updateResourceState(next, resource.key, 'retained');
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      if (resource.kind === 'dns-record' && !zone) {
        next = updateResourceState(next, resource.key, 'retained');
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      const immediatelyMissing = await verifyPlatformMutationOwnership(
        client,
        next,
        new Set(['routing-kv', resource.key]),
        { allowDeletedRoutingCheckpoint: args.purgeData },
      );
      if (immediatelyMissing.has(resource.key)) {
        next = updateResourceState(
          next,
          resource.key,
          resource.ownership === 'created' ? 'deleted' : 'retained',
        );
        await writeLifecycleCheckpoint(client, next);
        continue;
      }
      if (resource.kind === 'r2-bucket') {
        const bucket = (await client.listR2Buckets(next.account.id)).find(
          (entry) => entry.id === resource.id && entry.name === resource.name,
        );
        if (!bucket?.fingerprint) {
          throw ownershipError(
            `Cloudflare did not return a creation fingerprint for r2-bucket ${resource.name}`,
          );
        }
        if (!hasR2DeletionIntent(next, resource, bucket.fingerprint)) {
          next = recordR2DeletionIntent(next, resource, bucket.fingerprint);
          await writeLifecycleCheckpoint(client, next);
        }
        await client.emptyR2Bucket(
          next.account.id,
          resource.name,
          new Set([PLATFORM_R2_OWNERSHIP_MARKER_KEY]),
        );
        await verifyPlatformMutationOwnership(client, next, new Set(['routing-kv', resource.key]));
        await client.deleteR2Object(
          next.account.id,
          resource.name,
          PLATFORM_R2_OWNERSHIP_MARKER_KEY,
        );
      }
      await client.deleteResource(next.account.id, resource.kind, resource.id, zone?.id);
      next = updateResourceState(next, resource.key, 'deleted');
      await writeLifecycleCheckpoint(client, next);
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
    await writeRemoteManifestIfPresent(client, next).catch(() => {});
    throw error;
  }
}

export async function recoverDurablyMarkedProvisionIntents(
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
): Promise<PlatformInstallationManifest> {
  const candidates = [
    ['api-worker', 'worker', manifest.deployment.resources.apiWorker],
    ['proxy-worker', 'worker', manifest.deployment.resources.proxyWorker],
    ['tail-worker', 'worker', manifest.deployment.resources.tailWorker],
    ['dispatch-worker', 'worker', manifest.deployment.resources.dispatchWorker],
    ['assets-bucket', 'r2-bucket', manifest.deployment.resources.assetsBucket],
  ] as const;
  const pending = candidates.filter(
    ([key, kind, name]) =>
      !manifest.resources.some((resource) => resource.key === key) &&
      manifest.steps.some(
        (step) =>
          step.key === `provision-intent:${key}` &&
          step.resultHash === platformProvisionIntentHash(manifest, key, kind, name),
      ),
  );
  if (pending.length === 0) {
    return manifest;
  }
  const [workers, buckets] = await Promise.all([
    client.listWorkerNames(manifest.account.id),
    client.listR2Buckets(manifest.account.id),
  ]);
  let recovered = manifest;
  for (const [key, kind, name] of pending) {
    const live =
      kind === 'worker'
        ? workers.includes(name)
          ? { id: name, name }
          : null
        : (buckets.find((bucket) => bucket.name === name) ?? null);
    if (!live) {
      continue;
    }
    const resource: InstallationResource = {
      configHash: createHash('sha256').update(JSON.stringify({ kind, name })).digest('hex'),
      id: live.id,
      key,
      kind,
      name,
      ownership: 'created',
      state: 'ready',
    };
    const marker =
      kind === 'worker'
        ? (await client.getWorkerPlainTextBindings(manifest.account.id, name))
            .PLATFORM_OWNERSHIP_MARKER
        : await client.getR2Object(manifest.account.id, name, PLATFORM_R2_OWNERSHIP_MARKER_KEY);
    verifyResourceMarker(marker, manifest, resource);
    recovered = recordInstallationResource(recovered, resource, manifest.updatedAt);
  }
  return recovered;
}

const DATA_RESOURCE_KINDS = new Set([
  'ai-gateway',
  'dispatch-namespace',
  'hyperdrive',
  'kv-namespace',
  'r2-bucket',
]);

function isOwnershipVerifiableKind(kind: InstallationResource['kind']): boolean {
  return (
    kind === 'ai-gateway' ||
    kind === 'dispatch-namespace' ||
    kind === 'dns-record' ||
    kind === 'hyperdrive' ||
    kind === 'kv-namespace' ||
    kind === 'queue' ||
    kind === 'r2-bucket' ||
    kind === 'worker' ||
    kind === 'zone'
  );
}

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
  // AI Gateway ids are caller-selected and can be reused after deletion. The
  // API exposes no durable ownership marker, so automatic deletion could
  // remove a replacement gateway created by another installation.
  if (resource.kind === 'ai-gateway') {
    return false;
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
  client: PlatformOwnershipClient,
  manifest: PlatformInstallationManifest,
  targetKeys: ReadonlySet<string>,
  options: {
    allowDeletedRoutingCheckpoint?: boolean;
    allowMissingRoutingCheckpoint?: boolean;
    allowUninitializedRoutingCheckpoint?: boolean;
  } = {},
): Promise<ReadonlySet<string>> {
  const routing = requireResource(manifest, 'routing-kv');
  const targetResources = manifest.resources.filter(
    (resource) => targetKeys.has(resource.key) && resource.state === 'ready',
  );
  let rawRemote: string | null = null;
  let remote: PlatformInstallationManifest | null = null;
  let replacingMissingRoutingCheckpoint = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    rawRemote = await client.getKvValue(
      manifest.account.id,
      routing.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
    );
    if (rawRemote !== null) {
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
      if (targetResources.every((resource) => hasMatchingResourceProof(remote!, resource))) {
        break;
      }
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
  if (rawRemote === null) {
    if (
      (options.allowMissingRoutingCheckpoint || options.allowUninitializedRoutingCheckpoint) &&
      routing.ownership === 'created'
    ) {
      const namespaces = await client.listKvNamespaces(manifest.account.id);
      const routingMatches = namespaces.some(
        (entry) => entry.id === routing.id && entry.name === routing.name,
      );
      const routingIdentityCollides = namespaces.some(
        (entry) => entry.id === routing.id || entry.name === routing.name,
      );
      if (
        (options.allowMissingRoutingCheckpoint && !routingIdentityCollides) ||
        (options.allowUninitializedRoutingCheckpoint && routingMatches)
      ) {
        // The caller holds the authoritative PostgreSQL lifecycle lock. Repair
        // or resume may use that manifest as the replacement checkpoint, but
        // every surviving resource must still pass fresh inventory and marker
        // checks. An existing routing namespace is accepted only with the
        // exact id and name recorded by the database-authoritative manifest.
        remote = manifest;
        replacingMissingRoutingCheckpoint = true;
      }
    }
    if (
      !replacingMissingRoutingCheckpoint &&
      options.allowDeletedRoutingCheckpoint &&
      canResumeAfterRoutingCheckpointDeletion(manifest, targetKeys)
    ) {
      const namespaces = await client.listKvNamespaces(manifest.account.id);
      if (!namespaces.some((entry) => entry.id === routing.id)) {
        return new Set([routing.key]);
      }
    }
    if (!replacingMissingRoutingCheckpoint) {
      throw ownershipError('the remote installation checkpoint is missing');
    }
  }
  if (!remote) {
    throw ownershipError('the remote installation checkpoint is missing');
  }

  const localAdvancesRemote = isPlatformManifestMonotonicExtension(remote, manifest);
  for (const resource of targetResources) {
    const proof = remote.resources.find((entry) => entry.key === resource.key);
    if (!hasMatchingResourceProof(remote, resource)) {
      if (
        !proof &&
        localAdvancesRemote &&
        resource.kind !== 'ai-gateway' &&
        hasMatchingResourceIntent(remote, resource)
      ) {
        continue;
      }
      throw ownershipError(`the remote checkpoint does not own ${resource.kind} ${resource.name}`);
    }
  }

  const missing = new Set<string>(replacingMissingRoutingCheckpoint ? [routing.key] : []);
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

  for (const resource of targetResources) {
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
        const bucket = r2Buckets.find(
          (entry) => entry.id === resource.id && entry.name === resource.name,
        )!;
        const marker = await client.getR2Object(
          accountId,
          resource.name,
          PLATFORM_R2_OWNERSHIP_MARKER_KEY,
        );
        if (
          !marker &&
          bucket.fingerprint &&
          !replacingMissingRoutingCheckpoint &&
          hasR2DeletionIntent(manifest, resource, bucket.fingerprint) &&
          hasR2DeletionIntent(remote, resource, bucket.fingerprint)
        ) {
          continue;
        }
        verifyResourceMarker(marker, manifest, resource);
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

function hasMatchingResourceProof(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  const proof = manifest.resources.find((entry) => entry.key === resource.key);
  return (
    proof?.id === resource.id &&
    proof.kind === resource.kind &&
    proof.name === resource.name &&
    proof.ownership === resource.ownership
  );
}

function hasMatchingResourceIntent(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
): boolean {
  if (resource.ownership === 'created') {
    return manifest.steps.some(
      (step) =>
        step.key === `provision-intent:${resource.key}` &&
        step.resultHash ===
          platformProvisionIntentHash(manifest, resource.key, resource.kind, resource.name),
    );
  }
  if (resource.ownership === 'adopted') {
    return manifest.steps.some(
      (step) =>
        step.key === `adoption-intent:${resource.key}` &&
        step.resultHash ===
          platformAdoptionIntentHash(
            manifest,
            resource.key,
            resource.kind,
            resource.id,
            resource.name,
          ),
    );
  }
  return false;
}

export function isPlatformManifestMonotonicExtension(
  earlier: PlatformInstallationManifest,
  later: PlatformInstallationManifest,
): boolean {
  if (
    earlier.id !== later.id ||
    earlier.ownershipNonce !== later.ownershipNonce ||
    earlier.account.id !== later.account.id ||
    earlier.createdAt !== later.createdAt ||
    JSON.stringify(earlier.deployment) !== JSON.stringify(later.deployment) ||
    Date.parse(later.updatedAt) < Date.parse(earlier.updatedAt)
  ) {
    return false;
  }
  const resourcesAdvance = earlier.resources.every((resource) => {
    const next = later.resources.find((entry) => entry.key === resource.key);
    return (
      next?.id === resource.id &&
      next.kind === resource.kind &&
      next.name === resource.name &&
      next.ownership === resource.ownership &&
      (next.state === resource.state ||
        (resource.state === 'ready' && (next.state === 'deleted' || next.state === 'retained')))
    );
  });
  const stepsAdvance = earlier.steps.every((step) =>
    later.steps.some(
      (entry) =>
        entry.key === step.key &&
        entry.completedAt === step.completedAt &&
        entry.resultHash === step.resultHash,
    ),
  );
  return resourcesAdvance && stepsAdvance;
}

function hasNamedResource(
  entries: ReadonlyArray<{ id: string; name: string }>,
  resource: InstallationResource,
): boolean {
  return entries.some((entry) => entry.id === resource.id && entry.name === resource.name);
}

function r2DeletionIntentHash(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
  fingerprint: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: manifest.account.id,
        fingerprint,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: resource.id,
        resourceKey: resource.key,
        resourceName: resource.name,
      }),
    )
    .digest('hex');
}

function hasR2DeletionIntent(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
  fingerprint: string,
): boolean {
  return manifest.steps.some(
    (step) =>
      step.key === `delete-intent:${resource.key}` &&
      step.resultHash === r2DeletionIntentHash(manifest, resource, fingerprint),
  );
}

function recordR2DeletionIntent(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
  fingerprint: string,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `delete-intent:${resource.key}`,
      resultHash: r2DeletionIntentHash(manifest, resource, fingerprint),
    },
    now,
  );
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

function hasLifecycleStep(manifest: PlatformInstallationManifest, key: string): boolean {
  return manifest.steps.some((step) => step.key === key);
}

function currentTrafficGeneration(manifest: PlatformInstallationManifest): number {
  return Math.max(
    0,
    ...manifest.steps.flatMap((step) => {
      const match = /^traffic-enabled:(\d+)$/.exec(step.key);
      return match ? [Number(match[1])] : [];
    }),
  );
}

function recordLifecycleStep(
  manifest: PlatformInstallationManifest,
  key: string,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  return recordInstallationStep(manifest, { completedAt: now, key, resultHash: 'completed' }, now);
}

async function writeLifecycleCheckpointWithoutDatabase(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  databaseCheckpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
): Promise<void> {
  writeInstallationManifest(manifest);
  await writeRemoteManifestIfPresentWithoutDatabase(client, manifest, databaseCheckpoint);
}

async function writeRemoteManifestIfPresentWithoutDatabase(
  client: PlatformManagementClient,
  manifest: PlatformInstallationManifest,
  databaseCheckpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
): Promise<void> {
  await databaseCheckpoint?.(manifest);
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
