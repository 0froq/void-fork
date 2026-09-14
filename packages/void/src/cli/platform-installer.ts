import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  encodeCloudflareVersionMessage,
  parseCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
  type CloudflareCommandRunner,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import {
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  createPlatformWorkerConfigs,
  parsePlatformInstallationManifest,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  setInstallationEndpoints,
  transitionInstallation,
  type InstallationResource,
  type PlatformInstallationManifest,
} from '@void/platform';
import { getPlatformRuntimeDirectory, readPlatformRuntimeManifest } from '@void/platform/installer';
import { join } from 'pathslash';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';
import {
  platformAdoptionIntentHash,
  platformProvisionIntentHash,
  type PlatformInstallPlan,
  type PlatformInstallPlanAction,
} from './platform-plan.ts';
import {
  promoteInstallationSecrets,
  savePlatformConnection,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import { resolveWranglerArgv } from './preset.ts';

export const REMOTE_INSTALLATION_MANIFEST_KEY: string = PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY;

export type PlatformInstallationSecrets = Readonly<{
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  jwtSecret: string;
  projectSecretKey: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
}>;

export type PlatformDatabaseLifecycleLock = (() => Promise<void>) & {
  authoritativeManifest?: PlatformInstallationManifest | null;
  checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>;
};

type InstallerClient = Pick<
  PlatformCloudflareClient,
  | 'createDispatchNamespace'
  | 'createDnsRecord'
  | 'createAiGateway'
  | 'createHyperdrive'
  | 'createKvNamespace'
  | 'createQueue'
  | 'createR2Bucket'
  | 'createZone'
  | 'putKvValue'
  | 'putR2Object'
> &
  Partial<Pick<PlatformCloudflareClient, 'deleteResource' | 'removeRoutes'>>;

type PlatformWorkerRollback = () => Promise<void>;

export type PlatformInstallerDependencies = Readonly<{
  acquireDatabaseLifecycleLock: (
    databaseUrl: string,
    installationId: string,
    ownershipNonce: string,
  ) => Promise<PlatformDatabaseLifecycleLock>;
  claimDatabase?: (
    databaseUrl: string,
    installationId: string,
    ownershipNonce: string,
  ) => Promise<void>;
  client: InstallerClient;
  deployWorker?: (
    config: Record<string, unknown>,
    secrets: Record<string, string> | null,
    previousConfig: Record<string, unknown>,
  ) => Promise<PlatformWorkerRollback | void>;
  migrateDatabase?: (databaseUrl: string, migrationsFolder: string) => Promise<void>;
  now?: () => string;
  recoverWorkerCutover?: (input: {
    key: PlatformWorkerKey;
    previousVersionId: string | null;
    stagedVersionId: string;
    workerName: string;
  }) => Promise<void>;
  revalidateBeforeWorkerDeploy: (
    manifest: PlatformInstallationManifest,
    action: PlatformInstallPlanAction,
  ) => Promise<void>;
  verifyExistingOwnership?: (
    manifest: PlatformInstallationManifest,
    databaseCheckpointExists: boolean,
  ) => Promise<void>;
  verifyHealth?: (
    apiUrl: string,
    installationId: string,
    proxyUrl: string,
    applicationBaseDomain: string,
  ) => Promise<void>;
}>;

export type PlatformInstallationResult = Readonly<{
  manifest: PlatformInstallationManifest;
  waitingForDns: boolean;
  zoneNameServers: ReadonlyArray<string>;
}>;

export function createPlatformInstallationSecrets(input: {
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  existingInstallation?: boolean;
  jwtSecret?: string;
  projectSecretKey?: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  checkpoint?: Record<string, string> | null;
}): PlatformInstallationSecrets {
  const checkpoint = input.checkpoint ?? {};
  const required = (value: string, name: string): string => {
    if (!value) {
      throw new Error(`platform: ${name} is required to install the platform.`);
    }
    return value;
  };
  // Runtime signing/encryption keys are installation identity, not rotating
  // configuration. Once recovery material exists, an unrelated exported key
  // must never replace it during repair, upgrade, enable, or resume.
  const jwtSecret = input.existingInstallation
    ? checkpoint.jwtSecret || input.jwtSecret || ''
    : input.jwtSecret || checkpoint.jwtSecret || '';
  const projectSecretKey = input.existingInstallation
    ? checkpoint.projectSecretKey || input.projectSecretKey || ''
    : input.projectSecretKey || checkpoint.projectSecretKey || '';
  const resolvedJwtSecret = input.existingInstallation
    ? required(jwtSecret, 'VOID_PLATFORM_JWT_SECRET')
    : jwtSecret || randomBytes(32).toString('base64url');
  const resolvedProjectSecretKey = input.existingInstallation
    ? required(projectSecretKey, 'VOID_PLATFORM_PROJECT_SECRET_KEY')
    : projectSecretKey || randomBytes(32).toString('base64');
  if (Buffer.from(resolvedProjectSecretKey, 'base64').byteLength !== 32) {
    throw new Error(
      'platform: VOID_PLATFORM_PROJECT_SECRET_KEY must be a base64-encoded 32-byte key.',
    );
  }
  return {
    bootstrapGitHubId: required(
      input.bootstrapGitHubId || checkpoint.bootstrapGitHubId || '',
      'resolved administrator GitHub account id',
    ),
    bootstrapGitHubLogin: required(
      input.bootstrapGitHubLogin || checkpoint.bootstrapGitHubLogin || '',
      'VOID_PLATFORM_ADMIN_GITHUB_LOGIN',
    ),
    cloudflareApiToken: required(input.cloudflareApiToken, 'CLOUDFLARE_API_TOKEN'),
    databaseUrl: required(input.databaseUrl || checkpoint.databaseUrl || '', 'DATABASE_URL'),
    githubClientId: required(
      input.githubClientId || checkpoint.githubClientId || '',
      'VOID_PLATFORM_GITHUB_CLIENT_ID',
    ),
    githubClientSecret: required(
      input.githubClientSecret || checkpoint.githubClientSecret || '',
      'VOID_PLATFORM_GITHUB_CLIENT_SECRET',
    ),
    jwtSecret: resolvedJwtSecret,
    projectSecretKey: resolvedProjectSecretKey,
    r2AccessKeyId: required(
      input.r2AccessKeyId || checkpoint.r2AccessKeyId || '',
      'VOID_PLATFORM_R2_ACCESS_KEY_ID',
    ),
    r2SecretAccessKey: required(
      input.r2SecretAccessKey || checkpoint.r2SecretAccessKey || '',
      'VOID_PLATFORM_R2_SECRET_ACCESS_KEY',
    ),
  };
}

function secretCheckpoint(secrets: PlatformInstallationSecrets): Record<string, string> {
  return {
    bootstrapGitHubId: secrets.bootstrapGitHubId,
    bootstrapGitHubLogin: secrets.bootstrapGitHubLogin,
    databaseUrl: secrets.databaseUrl,
    githubClientId: secrets.githubClientId,
    githubClientSecret: secrets.githubClientSecret,
    jwtSecret: secrets.jwtSecret,
    projectSecretKey: secrets.projectSecretKey,
    r2AccessKeyId: secrets.r2AccessKeyId,
    r2SecretAccessKey: secrets.r2SecretAccessKey,
  };
}

export async function installPlatform(
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  existing: PlatformInstallationManifest | null,
  dependencies: PlatformInstallerDependencies,
): Promise<PlatformInstallationResult> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const version = readPlatformRuntimeManifest().platformVersion;
  const preserveDisabled = existing?.desiredState === 'disabled';
  const previousPublicEndpoints = stablePublicEndpointState(existing);
  let workerCutoverGeneration = 0;
  let workerRollbacks: Array<PlatformWorkerRollback> = [];
  let workerDeploymentCommitted = false;
  let manifest = existing;
  if (!manifest) {
    const createdAt = now();
    manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt,
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: randomBytes(32).toString('base64url'),
      platformVersion: version,
    });
    manifest = transitionInstallation(manifest, 'planned', now());
    writeInstallationManifest(manifest);
  } else if (manifest.status === 'uninstalled') {
    throw new Error(`platform: Installation ${manifest.id} has already been uninstalled.`);
  }
  if (preserveDisabled && manifest.desiredState !== 'disabled') {
    manifest = setInstallationDesiredState(manifest, 'disabled', now());
    writeInstallationManifest(manifest);
  }
  writePendingInstallationSecrets(manifest, secretCheckpoint(secrets));

  await (dependencies.claimDatabase ?? claimPlatformDatabase)(
    secrets.databaseUrl,
    manifest.id,
    manifest.ownershipNonce,
  );
  const releaseDatabaseLock = await dependencies.acquireDatabaseLifecycleLock(
    secrets.databaseUrl,
    manifest.id,
    manifest.ownershipNonce,
  );
  const writeRemoteInstallationCheckpoint = (
    client: InstallerClient,
    checkpointPlan: PlatformInstallPlan,
    checkpointManifest: PlatformInstallationManifest,
  ) =>
    writeRemoteInstallationCheckpointWithoutDatabase(
      client,
      checkpointPlan,
      checkpointManifest,
      releaseDatabaseLock,
    );
  const authoritative = releaseDatabaseLock.authoritativeManifest;
  if (authoritative && JSON.stringify(authoritative) !== JSON.stringify(manifest)) {
    writeInstallationManifest(authoritative);
    await releaseDatabaseLock();
    throw new Error(
      'platform: This installation changed on another host. Local state was refreshed; rerun the command to review a current plan.',
    );
  }
  try {
    if (existing) {
      await dependencies.verifyExistingOwnership?.(
        manifest,
        authoritative !== null && authoritative !== undefined,
      );
    }
    if (JSON.stringify(manifest.deployment) !== JSON.stringify(plan.deployment)) {
      manifest = { ...manifest, deployment: plan.deployment, updatedAt: now() };
      writeInstallationManifest(manifest);
      await releaseDatabaseLock.checkpoint?.(manifest);
    }
    if (manifest.platformVersion !== version) {
      manifest = { ...manifest, platformVersion: version, updatedAt: now() };
      writeInstallationManifest(manifest);
    }
    await releaseDatabaseLock.checkpoint?.(manifest);
    if (manifest.status !== 'provisioning') {
      manifest = transitionInstallation(manifest, 'provisioning', now());
      writeInstallationManifest(manifest);
    }

    // Establish the durable installation checkpoint before creating any
    // resource that may need to be reconciled or removed after interruption.
    const routingAction = plan.actions.find((action) => action.key === 'routing-kv')!;
    if (routingAction.action === 'adopt') {
      throw new Error('platform: The routing checkpoint cannot be adopted.');
    }
    if (routingAction.action === 'reuse') {
      if (
        !manifest.resources.some((resource) => resource.key === routingAction.key) &&
        routingAction.id
      ) {
        manifest = recordResource(manifest, routingAction, routingAction.id, 'created', now());
        writeInstallationManifest(manifest);
      }
    } else {
      manifest = recordProvisionIntent(manifest, routingAction, now());
      writeInstallationManifest(manifest);
      await releaseDatabaseLock.checkpoint?.(manifest);
      const routing = await createResource(
        dependencies.client,
        plan,
        routingAction,
        secrets.databaseUrl,
        '',
      );
      manifest = recordResource(manifest, routingAction, routing.id, 'created', now());
      writeInstallationManifest(manifest);
    }
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);

    const zoneAction = plan.actions.find((action) => action.key === 'zone')!;
    let zone = plan.zone;
    if (zoneAction.action === 'create') {
      manifest = recordProvisionIntent(manifest, zoneAction, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      zone = await dependencies.client.createZone(plan.account.id, zoneAction.name);
    }
    if (!zone) {
      throw new Error('platform: Cloudflare did not return the platform zone.');
    }
    if (zoneAction.action === 'adopt') {
      manifest = recordAdoptionIntent(manifest, zoneAction, zone.id, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
    manifest = recordResource(
      manifest,
      zoneAction,
      zone.id,
      zoneAction.action === 'adopt'
        ? 'adopted'
        : zoneAction.action === 'create' || hasProvisionIntent(manifest, zoneAction)
          ? 'created'
          : undefined,
      now(),
    );
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    if (zone.status !== 'active') {
      manifest = transitionInstallation(manifest, 'waiting-for-dns', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      return { manifest, waitingForDns: true, zoneNameServers: zone.nameServers };
    }

    for (const action of plan.actions.filter(
      (entry) => entry.key !== 'routing-kv' && entry.kind !== 'zone' && entry.kind !== 'worker',
    )) {
      if (action.action === 'adopt') {
        if (!action.id) {
          throw new Error(`platform: Adopted ${action.kind} ${action.name} has no id.`);
        }
        manifest = recordAdoptionIntent(manifest, action, action.id, now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        manifest = recordResource(manifest, action, action.id, 'adopted', now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        continue;
      }
      if (action.action === 'reuse') {
        if (!manifest.resources.some((resource) => resource.key === action.key) && action.id) {
          manifest = recordResource(manifest, action, action.id, 'created', now());
          writeInstallationManifest(manifest);
          await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
          await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        }
        continue;
      }
      manifest = recordProvisionIntent(manifest, action, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      const resource = await createResource(
        dependencies.client,
        plan,
        action,
        secrets.databaseUrl,
        zone.id,
      );
      manifest = recordResource(manifest, action, resource.id, 'created', now());
      writeInstallationManifest(manifest);
      await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }

    const runtimeDirectory = getPlatformRuntimeDirectory();
    const migrationHash = hash(
      readFileSync(join(runtimeDirectory, 'drizzle', 'meta', '_journal.json')),
    );
    const migrationStep = `database-migrations:${migrationHash}`;
    if (!manifest.steps.some((step) => step.key === migrationStep)) {
      await (dependencies.migrateDatabase ?? migratePlatformDatabase)(
        secrets.databaseUrl,
        join(runtimeDirectory, 'drizzle'),
      );
      manifest = recordInstallationStep(
        manifest,
        { completedAt: now(), key: migrationStep, resultHash: migrationHash },
        now(),
      );
      writeInstallationManifest(manifest);
    }

    manifest = transitionInstallation(manifest, 'deploying', now());
    writeInstallationManifest(manifest);
    const ids = Object.fromEntries(
      manifest.resources.map((resource) => [resource.key, resource.id]),
    );
    const bootstrapStep = 'bootstrap-access:v1';
    if (!manifest.steps.some((step) => step.key === bootstrapStep)) {
      const routingKv = requireId(ids, 'routing-kv');
      await dependencies.client.putKvValue(plan.account.id, routingKv, 'signup:enabled', 'true');
      await dependencies.client.putKvValue(
        plan.account.id,
        routingKv,
        'signup:allowlist',
        JSON.stringify([]),
      );
      manifest = recordInstallationStep(
        manifest,
        {
          completedAt: now(),
          key: bootstrapStep,
          resultHash: hash(secrets.bootstrapGitHubId),
        },
        now(),
      );
      writeInstallationManifest(manifest);
    }
    const runtime = readPlatformRuntimeManifest();
    const entrypoints = Object.fromEntries(
      Object.entries(runtime.artifacts).map(([key, artifact]) => [
        key,
        join(runtimeDirectory, artifact.path),
      ]),
    ) as Record<'api' | 'dispatch' | 'proxy' | 'tail', string>;
    verifyRuntimeArtifacts(runtimeDirectory);
    if (!preserveDisabled) {
      const trafficGeneration = nextTrafficGeneration(manifest);
      manifest = recordInstallationStep(
        manifest,
        {
          completedAt: now(),
          key: `traffic-enabled:${trafficGeneration}`,
          resultHash: String(trafficGeneration),
        },
        now(),
      );
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
    const configInput = {
      accountId: plan.account.id,
      apiUrl: plan.apiUrl,
      deployment: plan.deployment,
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      platformVersion: version,
      proxyUrl: plan.proxyUrl,
      resources: {
        hyperdrive: requireId(ids, 'hyperdrive'),
        isrCacheKv: requireId(ids, 'isr-cache-kv'),
        legacyAssetsKv: requireId(ids, 'legacy-assets-kv'),
        routingKv: requireId(ids, 'routing-kv'),
        zone: zone.id,
      },
      runtimeEntrypoints: entrypoints,
    };
    const configs = createPlatformWorkerConfigs({
      ...configInput,
      publicEndpoints: !preserveDisabled,
    });
    const previousConfigs = createPlatformWorkerConfigs({
      ...configInput,
      publicEndpoints: previousPublicEndpoints,
    });
    const interruptedCutover = interruptedWorkerCutover(manifest);
    if (interruptedCutover) {
      for (const key of [...interruptedCutover.staged.keys()].reverse()) {
        const snapshot = interruptedCutover.staged.get(key)!;
        const recoveryConfig = { ...configs[key], name: snapshot.workerName };
        const previousRecoveryConfig = { ...previousConfigs[key], name: snapshot.workerName };
        if (dependencies.recoverWorkerCutover) {
          await dependencies.recoverWorkerCutover({
            key,
            previousVersionId: snapshot.previousVersionId,
            stagedVersionId: snapshot.stagedVersionId,
            workerName: snapshot.workerName,
          });
        } else {
          await rollbackPlatformWorker({
            accountId: plan.account.id,
            activatedVersionId: snapshot.stagedVersionId,
            config: recoveryConfig,
            nextTriggers: readTriggerConfigFromObject(recoveryConfig),
            previousConfig: previousRecoveryConfig,
            previousTriggers: snapshot.previousTriggers,
            previousVersionId: snapshot.previousVersionId,
            removeCustomDomains: async () => {
              if (!dependencies.client.removeRoutes) {
                throw new Error('platform: Cloudflare route removal is unavailable.');
              }
              await dependencies.client.removeRoutes(
                plan.account.id,
                zone.id,
                new Set([snapshot.workerName]),
              );
            },
            removeNewWorker: async () => {
              if (!dependencies.client.deleteResource) {
                throw new Error('platform: Cloudflare Worker removal is unavailable.');
              }
              await dependencies.client.deleteResource(
                plan.account.id,
                'worker',
                snapshot.workerName,
                zone.id,
              );
            },
            workerExisted: snapshot.previousVersionId !== null,
            workerName: snapshot.workerName,
          });
        }
      }
      manifest = recordWorkerCutoverResolution(
        manifest,
        interruptedCutover.generation,
        'restored',
        now(),
      );
      manifest = recordWorkerTrafficState(
        manifest,
        interruptedCutover.generation,
        previousPublicEndpoints,
        now(),
      );
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
    workerCutoverGeneration = nextWorkerCutoverGeneration(manifest);
    for (const key of ['api', 'proxy', 'tail', 'dispatch'] as const) {
      const action = plan.actions.find((entry) => entry.key === `${key}-worker`)!;
      const workerSecrets =
        key === 'api'
          ? apiWorkerSecrets(secrets, plan.account.id, zone.id)
          : key === 'proxy'
            ? proxyWorkerSecrets(secrets, plan.account.id)
            : null;
      manifest = recordProvisionIntent(manifest, action, now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      await dependencies.revalidateBeforeWorkerDeploy(manifest, action);
      const rollback = dependencies.deployWorker
        ? await dependencies.deployWorker(configs[key], workerSecrets, previousConfigs[key])
        : await deployPlatformWorker(configs[key], workerSecrets, {
            onStaged: async (previousVersionId, stagedVersionId, previousTriggers) => {
              manifest = recordWorkerCutoverStage(
                manifest!,
                workerCutoverGeneration,
                key,
                previousVersionId,
                stagedVersionId,
                action.name,
                previousTriggers,
                now(),
              );
              writeInstallationManifest(manifest);
              await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
            },
            previousConfig: previousConfigs[key],
            previousPublicEndpoints,
            removeCustomDomains: async () => {
              if (!dependencies.client.removeRoutes) {
                throw new Error('platform: Cloudflare route removal is unavailable.');
              }
              await dependencies.client.removeRoutes(
                plan.account.id,
                zone.id,
                new Set([action.name]),
              );
            },
            removeNewWorker: async () => {
              if (!dependencies.client.deleteResource) {
                throw new Error('platform: Cloudflare Worker removal is unavailable.');
              }
              await dependencies.client.deleteResource(
                plan.account.id,
                'worker',
                action.name,
                zone.id,
              );
            },
            workerExisted: action.action !== 'create',
          });
      if (rollback) {
        workerRollbacks.push(rollback);
      }
      manifest = recordResource(manifest, action, action.name, 'created', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }

    manifest = setInstallationEndpoints(
      manifest,
      { apiUrl: plan.apiUrl, dashboardUrl: null, proxyUrl: plan.proxyUrl },
      now(),
    );
    if (preserveDisabled) {
      workerDeploymentCommitted = true;
      manifest = recordWorkerCutoverResolution(
        manifest,
        workerCutoverGeneration,
        'committed',
        now(),
      );
      manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, false, now());
      manifest = transitionInstallation(manifest, 'disabled', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      promoteInstallationSecrets(manifest);
      saveInstalledPlatformConnection(plan, manifest);
      return { manifest, waitingForDns: false, zoneNameServers: zone.nameServers };
    }
    manifest = transitionInstallation(manifest, 'verifying', now());
    writeInstallationManifest(manifest);
    await (dependencies.verifyHealth ?? verifyPlatformHealth)(
      plan.apiUrl,
      manifest.id,
      plan.proxyUrl,
      plan.deployment.application.baseDomain,
    );
    workerDeploymentCommitted = true;
    manifest = recordWorkerCutoverResolution(manifest, workerCutoverGeneration, 'committed', now());
    manifest = recordWorkerTrafficState(manifest, workerCutoverGeneration, true, now());
    manifest = transitionInstallation(manifest, 'installed', now());
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    promoteInstallationSecrets(manifest);
    saveInstalledPlatformConnection(plan, manifest);
    return { manifest, waitingForDns: false, zoneNameServers: zone.nameServers };
  } catch (error) {
    let failure: unknown = error;
    if (!workerDeploymentCommitted && workerRollbacks.length > 0) {
      const rollbackFailures: Array<string> = [];
      for (const rollback of workerRollbacks.reverse()) {
        try {
          await rollback();
        } catch (rollbackError) {
          rollbackFailures.push(errorMessage(rollbackError));
        }
      }
      workerRollbacks = [];
      if (rollbackFailures.length > 0) {
        failure = new Error(
          `platform: ${errorMessage(error)} Automatic Worker rollback was incomplete: ${rollbackFailures.join('; ')} Inspect the installation before retrying.`,
          { cause: error },
        );
      } else if (workerCutoverGeneration > 0) {
        manifest = recordWorkerCutoverResolution(
          manifest,
          workerCutoverGeneration,
          'restored',
          now(),
        );
        manifest = recordWorkerTrafficState(
          manifest,
          workerCutoverGeneration,
          previousPublicEndpoints,
          now(),
        );
        writeInstallationManifest(manifest);
      }
    }
    if (manifest.status !== 'failed' && manifest.status !== 'uninstalled') {
      try {
        manifest = transitionInstallation(manifest, 'failed', now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      } catch {
        // Preserve the original failure when a terminal state cannot transition.
      }
    }
    throw failure;
  } finally {
    await releaseDatabaseLock();
  }
}

async function writeR2OwnershipMarkerIfNeeded(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): Promise<void> {
  if (action.kind !== 'r2-bucket') {
    return;
  }
  const bucket = manifest.resources.find(
    (resource) => resource.key === action.key && resource.state === 'ready',
  );
  if (!bucket || bucket.ownership !== 'created') {
    return;
  }
  await client.putR2Object(
    plan.account.id,
    bucket.name,
    PLATFORM_R2_OWNERSHIP_MARKER_KEY,
    JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: plan.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: bucket.id,
        resourceKey: bucket.key,
        resourceKind: bucket.kind,
        resourceName: bucket.name,
      }),
    ),
  );
}

function saveInstalledPlatformConnection(
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
): void {
  savePlatformConnection({
    accountId: plan.account.id,
    apiUrl: plan.apiUrl,
    applicationDomain: plan.deployment.application.baseDomain,
    displayName: plan.deployment.displayName,
    installationId: manifest.id,
    kind: 'installed',
    proxyUrl: plan.proxyUrl,
  });
}

async function writeRemoteInstallationCheckpointWithoutDatabase(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  databaseLock?: PlatformDatabaseLifecycleLock,
): Promise<void> {
  await databaseLock?.checkpoint?.(manifest);
  const routing = manifest.resources.find(
    (resource) =>
      resource.key === 'routing-kv' &&
      resource.kind === 'kv-namespace' &&
      resource.ownership === 'created' &&
      resource.state === 'ready',
  );
  if (!routing) {
    return;
  }
  await client.putKvValue(
    plan.account.id,
    routing.id,
    REMOTE_INSTALLATION_MANIFEST_KEY,
    JSON.stringify(manifest),
  );
}

function recordProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  now: string,
): PlatformInstallationManifest {
  const previousResourceId =
    manifest.resources.find((resource) => resource.key === action.key)?.id ?? null;
  const resultHash = platformProvisionIntentHash(
    manifest,
    action.key,
    action.kind,
    action.name,
    previousResourceId,
  );
  const existing = manifest.steps.find(
    (step) =>
      (step.key === `provision-intent:${action.key}` ||
        step.key.startsWith(`provision-intent:${action.key}:`)) &&
      step.resultHash === resultHash,
  );
  if (existing) {
    return manifest;
  }
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `provision-intent:${action.key}:${resultHash.slice(0, 16)}`,
      resultHash,
    },
    now,
  );
}

function recordAdoptionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  id: string,
  now: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `adoption-intent:${action.key}`,
      resultHash: platformAdoptionIntentHash(manifest, action.key, action.kind, id, action.name),
    },
    now,
  );
}

function hasProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): boolean {
  const previousResourceId =
    manifest.resources.find((resource) => resource.key === action.key)?.id ?? null;
  return manifest.steps.some(
    (step) =>
      (step.key === `provision-intent:${action.key}` ||
        step.key.startsWith(`provision-intent:${action.key}:`)) &&
      step.resultHash ===
        platformProvisionIntentHash(
          manifest,
          action.key,
          action.kind,
          action.name,
          previousResourceId,
        ),
  );
}

async function createResource(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  action: PlatformInstallPlanAction,
  databaseUrl: string,
  zoneId: string,
): Promise<{ id: string; name: string }> {
  switch (action.kind) {
    case 'ai-gateway':
      return client.createAiGateway(plan.account.id, action.name);
    case 'dns-record':
      return client.createDnsRecord(zoneId, action.name);
    case 'kv-namespace':
      return client.createKvNamespace(plan.account.id, action.name);
    case 'r2-bucket':
      return client.createR2Bucket(plan.account.id, action.name);
    case 'queue':
      return client.createQueue(plan.account.id, action.name);
    case 'dispatch-namespace':
      return client.createDispatchNamespace(plan.account.id, action.name);
    case 'hyperdrive':
      return client.createHyperdrive(plan.account.id, action.name, databaseUrl);
    default:
      throw new Error(`platform: Cannot provision ${action.kind} in the resource phase.`);
  }
}

function recordResource(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  id: string,
  ownership: InstallationResource['ownership'] | undefined,
  now: string,
): PlatformInstallationManifest {
  const previous = manifest.resources.find((resource) => resource.key === action.key);
  return recordInstallationResource(
    manifest,
    {
      configHash: hash(JSON.stringify({ kind: action.kind, name: action.name })),
      id,
      key: action.key,
      kind: action.kind,
      name: action.name,
      ownership: ownership ?? previous?.ownership ?? 'created',
      state: 'ready',
    },
    now,
  );
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireId(ids: Record<string, string>, key: string): string {
  const id = ids[key];
  if (!id) {
    throw new Error(`platform: Installation manifest is missing ${key}.`);
  }
  return id;
}

function apiWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
  zoneId: string,
): Record<string, string> {
  return {
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    CF_ZONE_ID: zoneId,
    GITHUB_CLIENT_ID: secrets.githubClientId,
    GITHUB_CLIENT_SECRET: secrets.githubClientSecret,
    JWT_SECRET: secrets.jwtSecret,
    PLATFORM_BOOTSTRAP_GITHUB_ID: secrets.bootstrapGitHubId,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: 'v1',
    PROJECT_SECRET_KEYS_JSON: JSON.stringify({ v1: secrets.projectSecretKey }),
    R2_ACCESS_KEY_ID: secrets.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: secrets.r2SecretAccessKey,
  };
}

export async function resolveBootstrapGitHubId(
  login: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const normalizedLogin = login.trim();
  if (!normalizedLogin) {
    throw new Error('platform: VOID_PLATFORM_ADMIN_GITHUB_LOGIN is required.');
  }
  const response = await fetcher(
    `https://api.github.com/users/${encodeURIComponent(normalizedLogin)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'void-platform-installer',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `platform: Could not resolve GitHub user ${JSON.stringify(normalizedLogin)} (HTTP ${response.status}). Verify the username and retry.`,
    );
  }
  const body = (await response.json()) as { id?: unknown };
  const id = typeof body.id === 'number' && Number.isSafeInteger(body.id) ? String(body.id) : '';
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new Error(
      'platform: GitHub returned an invalid account id for the initial administrator.',
    );
  }
  return id;
}

function proxyWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
): Record<string, string> {
  return {
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    JWT_SECRET: secrets.jwtSecret,
  };
}

async function migratePlatformDatabase(
  databaseUrl: string,
  migrationsFolder: string,
): Promise<void> {
  const [{ Pool }, { drizzle }, { migrate }] = await Promise.all([
    import('pg'),
    import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'),
  ]);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export async function claimPlatformDatabase(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await claimPlatformDatabaseConnection(client, installationId, ownershipNonce);
  } finally {
    client.release();
    await pool.end();
  }
}

export async function acquirePlatformDatabaseLifecycleLock(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformDatabaseLifecycleLock> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const releaseConnectionLock = await acquirePlatformDatabaseLifecycleLockConnection(
      client,
      installationId,
      ownershipNonce,
    );
    const release: PlatformDatabaseLifecycleLock = async () => {
      try {
        await releaseConnectionLock();
      } finally {
        client.release();
        await pool.end();
      }
    };
    release.authoritativeManifest = releaseConnectionLock.authoritativeManifest;
    release.checkpoint = releaseConnectionLock.checkpoint;
    return release;
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }
}

export async function readPlatformDatabaseLifecycleManifest(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformInstallationManifest | null> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await readPlatformDatabaseLifecycleManifestConnection(
      pool,
      installationId,
      ownershipNonce,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('platform:')) {
      throw error;
    }
    throw new Error(
      `platform: Could not read the PostgreSQL lifecycle checkpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await pool.end();
  }
}

type DatabaseClaimConnection = Readonly<{
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<{ rows: ReadonlyArray<Row> }>;
}>;

export async function readPlatformDatabaseLifecycleManifestConnection(
  client: DatabaseClaimConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformInstallationManifest | null> {
  const result = await client.query<{
    installation_id: string;
    lifecycle_manifest: unknown;
    ownership_nonce: string;
  }>(
    `SELECT "installation_id", "ownership_nonce", "lifecycle_manifest"
     FROM "__void_platform_installation"
     WHERE "singleton" = true`,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.installation_id !== installationId ||
    row.ownership_nonce !== ownershipNonce
  ) {
    throw new Error(
      'platform: The PostgreSQL database ownership claim does not match this installation.',
    );
  }
  if (row.lifecycle_manifest === null || row.lifecycle_manifest === undefined) {
    return null;
  }
  const manifest = parsePlatformInstallationManifest(row.lifecycle_manifest);
  if (manifest.id !== installationId || manifest.ownershipNonce !== ownershipNonce) {
    throw new Error(
      'platform: The PostgreSQL lifecycle checkpoint does not match this installation.',
    );
  }
  return manifest;
}

export async function acquirePlatformDatabaseLifecycleLockConnection(
  client: DatabaseClaimConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformDatabaseLifecycleLock> {
  await client.query(
    `ALTER TABLE "__void_platform_installation"
     ADD COLUMN IF NOT EXISTS "lifecycle_manifest" jsonb`,
  );
  const claim = await client.query<{ installation_id: string; ownership_nonce: string }>(
    `SELECT "installation_id", "ownership_nonce"
     FROM "__void_platform_installation"
     WHERE "singleton" = true`,
  );
  const owner = claim.rows[0];
  if (
    !owner ||
    owner.installation_id !== installationId ||
    owner.ownership_nonce !== ownershipNonce
  ) {
    throw new Error(
      'platform: The PostgreSQL database ownership claim does not match this installation.',
    );
  }
  const lockIdentity = `void-platform-lifecycle-v1:${installationId}:${ownershipNonce}`;
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS "acquired"',
    [lockIdentity],
  );
  if (result.rows[0]?.acquired !== true) {
    throw new Error(
      `platform: Another lifecycle operation is active for installation ${installationId} on another host.`,
    );
  }
  let authoritativeManifest: PlatformInstallationManifest | null = null;
  try {
    const checkpoint = await client.query<{ lifecycle_manifest: unknown }>(
      `SELECT "lifecycle_manifest"
       FROM "__void_platform_installation"
       WHERE "singleton" = true
         AND "installation_id" = $1
         AND "ownership_nonce" = $2`,
      [installationId, ownershipNonce],
    );
    const value = checkpoint.rows[0]?.lifecycle_manifest;
    if (checkpoint.rows.length !== 1) {
      throw new Error('platform: The PostgreSQL database ownership claim changed unexpectedly.');
    }
    if (value !== null && value !== undefined) {
      authoritativeManifest = parsePlatformInstallationManifest(value);
      if (
        authoritativeManifest.id !== installationId ||
        authoritativeManifest.ownershipNonce !== ownershipNonce
      ) {
        throw new Error(
          'platform: The PostgreSQL lifecycle checkpoint does not match this installation.',
        );
      }
    }
  } catch (error) {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
    if (error instanceof Error && error.message.startsWith('platform:')) {
      throw error;
    }
    throw new Error(
      `platform: The PostgreSQL lifecycle checkpoint is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let released = false;
  const release: PlatformDatabaseLifecycleLock = async () => {
    if (released) {
      return;
    }
    released = true;
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
  };
  release.authoritativeManifest = authoritativeManifest;
  release.checkpoint = async (manifest) => {
    if (released) {
      throw new Error('platform: Cannot checkpoint lifecycle state after releasing its lock.');
    }
    if (manifest.id !== installationId || manifest.ownershipNonce !== ownershipNonce) {
      throw new Error('platform: Refusing to checkpoint lifecycle state for another installation.');
    }
    const updated = await client.query<{ singleton: boolean }>(
      `UPDATE "__void_platform_installation"
       SET "lifecycle_manifest" = $1::jsonb
       WHERE "singleton" = true
         AND "installation_id" = $2
         AND "ownership_nonce" = $3
       RETURNING "singleton"`,
      [JSON.stringify(manifest), installationId, ownershipNonce],
    );
    if (updated.rows.length !== 1) {
      throw new Error('platform: The PostgreSQL database ownership claim changed unexpectedly.');
    }
    release.authoritativeManifest = manifest;
  };
  return release;
}

export async function claimPlatformDatabaseConnection(
  client: DatabaseClaimConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('void-platform-installation-ownership-v1'))`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS "__void_platform_installation" (
        "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
        "installation_id" text NOT NULL,
        "ownership_nonce" text NOT NULL,
        "claimed_at" timestamptz NOT NULL DEFAULT now(),
        "lifecycle_manifest" jsonb
      )
    `);
    await client.query(
      `ALTER TABLE "__void_platform_installation"
       ADD COLUMN IF NOT EXISTS "lifecycle_manifest" jsonb`,
    );
    const result = await client.query<{
      installation_id: string;
      ownership_nonce: string;
    }>(
      `SELECT "installation_id", "ownership_nonce"
       FROM "__void_platform_installation"
       WHERE "singleton" = true
       FOR UPDATE`,
    );
    const claim = result.rows[0];
    if (!claim) {
      const contents = await client.query<{ schemaname: string; tablename: string }>(
        `SELECT "schemaname", "tablename"
         FROM "pg_catalog"."pg_tables"
         WHERE "schemaname" = ANY (current_schemas(false))
           AND "tablename" <> '__void_platform_installation'
         ORDER BY "schemaname", "tablename"
         LIMIT 1`,
      );
      if (contents.rows.length > 0) {
        const table = contents.rows[0]!;
        throw new Error(
          `platform: Refusing to claim a non-empty PostgreSQL database (found ${table.schemaname}.${table.tablename}). Use a dedicated empty database for each installation.`,
        );
      }
      await client.query(
        `INSERT INTO "__void_platform_installation"
           ("singleton", "installation_id", "ownership_nonce")
         VALUES (true, $1, $2)`,
        [installationId, ownershipNonce],
      );
    } else if (
      claim.installation_id !== installationId ||
      claim.ownership_nonce !== ownershipNonce
    ) {
      throw new Error(
        `platform: This PostgreSQL database is already claimed by Void platform installation ${claim.installation_id}. Use a dedicated empty database for each installation.`,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => ({ rows: [] }));
    throw error;
  }
}

type PlatformWorkerDeploymentOptions = Readonly<{
  onStaged: (
    previousVersionId: string | null,
    stagedVersionId: string,
    previousTriggers: CloudflareTriggerConfig,
  ) => Promise<void>;
  previousConfig: Record<string, unknown>;
  previousPublicEndpoints: boolean;
  removeCustomDomains: () => Promise<void>;
  removeNewWorker: () => Promise<void>;
  workerExisted: boolean;
}>;

async function deployPlatformWorker(
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  options: PlatformWorkerDeploymentOptions,
): Promise<PlatformWorkerRollback> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-deploy-'));
  const workerName = String(config.name);
  const accountId = String(config.account_id);
  let activatedVersionId: string | null = null;
  let uploadedVersionId: string | null = null;
  let previousVersionId: string | null = null;
  let previousTriggers = readTriggerConfigFromObject(options.previousConfig);
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const nextTriggers = readCloudflareTriggerConfig(configPath);
    if (options.workerExisted) {
      const previous = await readActivePlatformWorkerSnapshot(configPath, accountId, workerName);
      previousVersionId = previous.versionId;
      previousTriggers = resolvePlatformPreviousTriggerConfig(
        previous.triggerConfig,
        previousTriggers,
        options.previousPublicEndpoints,
      );
    }
    const argv = [
      ...(options.workerExisted ? ['versions', 'upload'] : ['deploy']),
      '--config',
      configPath,
      '--strict',
      '--experimental-provision=false',
      '--experimental-auto-create=false',
      ...(!options.workerExisted ? ['--autoconfig=false'] : []),
      '--message',
      encodeCloudflareVersionMessage([], nextTriggers),
    ];
    if (secrets) {
      const secretsPath = join(directory, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
      argv.push('--secrets-file', secretsPath);
    }
    const uploaded = await runPlatformWrangler(argv, accountId, directory, true);
    uploadedVersionId = parseUploadedPlatformWorkerVersion(
      `${uploaded.stdout}\n${uploaded.stderr}`,
    );
    if (!options.workerExisted) {
      activatedVersionId = uploadedVersionId;
    }
    assertCleanPlatformWrangler(
      uploaded,
      `${options.workerExisted ? 'upload' : 'bootstrap'} ${workerName}`,
    );
    if (!uploadedVersionId) {
      throw new Error(
        `platform: Wrangler uploaded ${workerName} without reporting its immutable version id.`,
      );
    }
    await options.onStaged(previousVersionId, uploadedVersionId, previousTriggers);
    if (options.workerExisted) {
      const ownerBeforeActivation = await readActivePlatformWorkerVersion(
        configPath,
        accountId,
        workerName,
      );
      if (ownerBeforeActivation !== previousVersionId) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently before activation; refusing to overwrite it.`,
        );
      }
      activatedVersionId = uploadedVersionId;
      const activated = await runPlatformWrangler(
        [
          'versions',
          'deploy',
          `${uploadedVersionId}@100`,
          '--config',
          configPath,
          '--message',
          `Void platform activation ${uploadedVersionId}`,
          '--yes',
        ],
        accountId,
        directory,
        true,
      );
      assertCleanPlatformWrangler(activated, `activate ${workerName}`);
    }
    const triggers = await stabilizeCloudflareVersionTriggers({
      configPath,
      knownTriggerConfigs: {
        [uploadedVersionId]: nextTriggers,
        ...(previousVersionId ? { [previousVersionId]: previousTriggers } : {}),
      },
      previousTriggerConfig: previousTriggers,
      publishEmptyCustomDomains: async () => {
        await options.removeCustomDomains();
        return cleanPlatformCommandResult();
      },
      runWrangler: platformWorkerCommandRunner(accountId, directory),
      targetTriggerConfig: nextTriggers,
      targetVersionId: uploadedVersionId,
      workerName,
    });
    assertPlatformTriggerStabilization(triggers, workerName, uploadedVersionId, 'publish');
    const rollback = () =>
      rollbackPlatformWorker({
        accountId,
        activatedVersionId: uploadedVersionId!,
        config,
        nextTriggers,
        previousConfig: options.previousConfig,
        previousTriggers,
        previousVersionId,
        removeCustomDomains: options.removeCustomDomains,
        removeNewWorker: options.removeNewWorker,
        workerExisted: options.workerExisted,
        workerName,
      });
    return rollback;
  } catch (error) {
    let recoveryError: unknown = null;
    try {
      if (activatedVersionId && uploadedVersionId) {
        await rollbackPlatformWorker({
          accountId,
          activatedVersionId: uploadedVersionId,
          config,
          nextTriggers: readTriggerConfigFromObject(config),
          previousConfig: options.previousConfig,
          previousTriggers,
          previousVersionId,
          removeCustomDomains: options.removeCustomDomains,
          removeNewWorker: options.removeNewWorker,
          workerExisted: options.workerExisted,
          workerName,
        });
      } else if (!options.workerExisted && uploadedVersionId) {
        await options.removeNewWorker();
      }
    } catch (rollbackError) {
      recoveryError = rollbackError;
    }
    if (recoveryError) {
      throw new Error(
        `platform: ${errorMessage(error)} Automatic recovery for ${workerName} was incomplete: ${errorMessage(recoveryError)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function rollbackPlatformWorker(input: {
  accountId: string;
  activatedVersionId: string;
  config: Record<string, unknown>;
  nextTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousConfig: Record<string, unknown>;
  previousTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousVersionId: string | null;
  removeCustomDomains: () => Promise<void>;
  removeNewWorker: () => Promise<void>;
  workerExisted: boolean;
  workerName: string;
}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-rollback-'));
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, `${JSON.stringify(input.config, null, 2)}\n`, { mode: 0o600 });
    const currentVersionId = await readActivePlatformWorkerVersion(
      configPath,
      input.accountId,
      input.workerName,
      !input.workerExisted,
    );
    if (!input.workerExisted) {
      if (currentVersionId !== null && currentVersionId !== input.activatedVersionId) {
        throw new Error(
          `Worker ${input.workerName} changed concurrently from installer version ${input.activatedVersionId} to ${currentVersionId}; refusing to delete it.`,
        );
      }
      await input.removeNewWorker();
      return;
    }
    if (
      currentVersionId !== input.previousVersionId &&
      currentVersionId !== input.activatedVersionId
    ) {
      throw new Error(
        `Worker ${input.workerName} changed concurrently from installer version ${input.activatedVersionId} to ${currentVersionId ?? 'no active version'}; refusing to overwrite it.`,
      );
    }
    if (!input.previousVersionId) {
      throw new Error(`Worker ${input.workerName} has no previous version to restore.`);
    }
    if (currentVersionId === input.activatedVersionId) {
      const restored = await runPlatformWrangler(
        [
          'versions',
          'deploy',
          `${input.previousVersionId}@100`,
          '--config',
          configPath,
          '--message',
          `Void automatic rollback after platform deployment failed`,
          '--yes',
        ],
        input.accountId,
        directory,
        true,
      );
      assertCleanPlatformWrangler(restored, `restore ${input.workerName}`);
    }
    const previousConfigPath = join(directory, 'wrangler.previous.json');
    writeFileSync(previousConfigPath, `${JSON.stringify(input.previousConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const triggers = await stabilizeCloudflareVersionTriggers({
      configPath: previousConfigPath,
      knownTriggerConfigs: {
        [input.activatedVersionId]: input.nextTriggers,
        [input.previousVersionId]: input.previousTriggers,
      },
      previousTriggerConfig: input.nextTriggers,
      publishEmptyCustomDomains: async () => {
        await input.removeCustomDomains();
        return cleanPlatformCommandResult();
      },
      runWrangler: platformWorkerCommandRunner(input.accountId, directory),
      targetTriggerConfig: input.previousTriggers,
      targetVersionId: input.previousVersionId,
      workerName: input.workerName,
    });
    assertPlatformTriggerStabilization(
      triggers,
      input.workerName,
      input.previousVersionId,
      'restore',
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function platformWorkerCommandRunner(accountId: string, cwd: string): CloudflareCommandRunner {
  return (args, options) => runPlatformWrangler(args, accountId, cwd, options.capture);
}

async function runPlatformWrangler(
  args: ReadonlyArray<string>,
  accountId: string,
  cwd: string,
  capture: boolean,
): Promise<CloudflareCommandResult> {
  const [command, ...prefix] = resolveWranglerArgv(process.cwd());
  const result = spawnSync(command, [...prefix, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN:
        process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (!capture) {
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }
  return {
    status: result.status ?? 1,
    stderr,
    stdout,
  };
}

async function readActivePlatformWorkerVersion(
  configPath: string,
  accountId: string,
  workerName: string,
  allowMissing = false,
): Promise<string | null> {
  const result = await runPlatformWrangler(
    ['deployments', 'status', '--config', configPath, '--name', workerName, '--json'],
    accountId,
    process.cwd(),
    true,
  );
  if (result.status !== 0) {
    if (allowMissing) {
      return null;
    }
    assertCleanPlatformWrangler(result, `read active version for ${workerName}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`platform: Wrangler returned malformed deployment status for ${workerName}.`);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { versions?: unknown }).versions)
  ) {
    throw new Error(`platform: Wrangler returned malformed deployment status for ${workerName}.`);
  }
  const active = (value as { versions: Array<unknown> }).versions.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      Number((entry as { percentage?: unknown }).percentage) === 100,
  );
  if (
    active.length !== 1 ||
    typeof (active[0] as { version_id?: unknown }).version_id !== 'string'
  ) {
    return null;
  }
  return (active[0] as { version_id: string }).version_id;
}

async function readActivePlatformWorkerSnapshot(
  configPath: string,
  accountId: string,
  workerName: string,
): Promise<{ triggerConfig: CloudflareTriggerConfig; versionId: string }> {
  const versionId = await readActivePlatformWorkerVersion(configPath, accountId, workerName);
  if (!versionId) {
    throw new Error(
      `platform: Existing Worker ${workerName} has no single active production version.`,
    );
  }
  const result = await runPlatformWrangler(
    ['versions', 'view', versionId, '--config', configPath, '--name', workerName, '--json'],
    accountId,
    process.cwd(),
    true,
  );
  assertCleanPlatformWrangler(result, `read rollback metadata for ${workerName}`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`platform: Wrangler returned malformed version metadata for ${workerName}.`);
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`platform: Wrangler returned malformed version metadata for ${workerName}.`);
  }
  const annotations = (value as { annotations?: unknown }).annotations;
  const message =
    annotations &&
    typeof annotations === 'object' &&
    typeof (annotations as Record<string, unknown>)['workers/message'] === 'string'
      ? ((annotations as Record<string, string>)['workers/message'] ?? null)
      : null;
  const metadata = parseCloudflareVersionMessage(message);
  if (metadata?.schema !== 2) {
    throw new Error(
      `platform: Active Worker ${workerName} predates safe trigger snapshots. Refusing to upgrade because its routes, cron, and queue consumers could not be restored after a failed cutover.`,
    );
  }
  return { triggerConfig: metadata.triggerConfig, versionId };
}

function parseUploadedPlatformWorkerVersion(output: string): string | null {
  return /(?:Worker|Current) Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(output)?.[1] ?? null;
}

function assertCleanPlatformWrangler(result: CloudflareCommandResult, operation: string): void {
  if (result.status !== 0) {
    throw new Error(
      `platform: Wrangler failed to ${operation} (${result.stderr.trim() || `exit ${result.status}`}).`,
    );
  }
}

function cleanPlatformCommandResult(): CloudflareCommandResult {
  return { status: 0, stderr: '', stdout: '' };
}

function assertPlatformTriggerStabilization(
  result: Awaited<ReturnType<typeof stabilizeCloudflareVersionTriggers>>,
  workerName: string,
  targetVersionId: string,
  operation: string,
): void {
  if (!result.ok) {
    throw new Error(
      `platform: Failed to ${operation} triggers for ${workerName} (${result.reason}).`,
    );
  }
  if (!result.targetOwnsTraffic) {
    throw new Error(
      `platform: Worker ${workerName} was superseded by ${result.activeVersionId} while publishing ${targetVersionId}; its active trigger state was repaired.`,
    );
  }
}

function readTriggerConfigFromObject(config: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-triggers-'));
  try {
    const path = join(directory, 'wrangler.json');
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return readCloudflareTriggerConfig(path);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function verifyRuntimeArtifacts(runtimeDirectory: string): void {
  const manifest = readPlatformRuntimeManifest();
  for (const artifact of Object.values(manifest.artifacts)) {
    const path = join(runtimeDirectory, artifact.path);
    const contents = readFileSync(path);
    if (contents.byteLength !== artifact.size || hash(contents) !== artifact.sha256) {
      throw new Error(`platform: Packaged Worker artifact failed integrity verification: ${path}.`);
    }
  }
}

function nextTrafficGeneration(manifest: PlatformInstallationManifest): number {
  return (
    Math.max(
      0,
      ...manifest.steps.flatMap((step) => {
        const match = /^traffic-enabled:(\d+)$/.exec(step.key);
        return match ? [Number(match[1])] : [];
      }),
    ) + 1
  );
}

type PlatformWorkerKey = 'api' | 'proxy' | 'tail' | 'dispatch';

type PlatformWorkerCutoverSnapshot = Readonly<{
  previousVersionId: string | null;
  previousTriggers: CloudflareTriggerConfig;
  stagedVersionId: string;
  workerName: string;
}>;

type InterruptedWorkerCutover = Readonly<{
  generation: number;
  staged: ReadonlyMap<PlatformWorkerKey, PlatformWorkerCutoverSnapshot>;
}>;

function nextWorkerCutoverGeneration(manifest: PlatformInstallationManifest): number {
  return (
    Math.max(
      0,
      ...manifest.steps.flatMap((step) => {
        const match = /^worker-(?:cutover|traffic-state):(\d+)/.exec(step.key);
        return match ? [Number(match[1])] : [];
      }),
    ) + 1
  );
}

function recordWorkerCutoverStage(
  manifest: PlatformInstallationManifest,
  generation: number,
  key: PlatformWorkerKey,
  previousVersionId: string | null,
  stagedVersionId: string,
  workerName: string,
  previousTriggers: CloudflareTriggerConfig,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:staged:${key}`,
      resultHash: Buffer.from(
        JSON.stringify({
          previousTriggers,
          previousVersionId,
          schema: 1,
          stagedVersionId,
          workerName,
        }),
      ).toString('base64url'),
    },
    completedAt,
  );
}

function recordWorkerCutoverResolution(
  manifest: PlatformInstallationManifest,
  generation: number,
  resolution: 'committed' | 'restored',
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:${resolution}`,
      resultHash: resolution,
    },
    completedAt,
  );
}

function parseWorkerCutoverSnapshot(value: string): PlatformWorkerCutoverSnapshot | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      previousTriggers?: unknown;
      previousVersionId?: unknown;
      schema?: unknown;
      stagedVersionId?: unknown;
      workerName?: unknown;
    };
    const metadata = parseCloudflareVersionMessage(
      `void:${JSON.stringify({
        migrations: [],
        schema: 2,
        triggerConfig: parsed.previousTriggers,
      })}`,
    );
    if (
      parsed.schema !== 1 ||
      (parsed.previousVersionId !== null && typeof parsed.previousVersionId !== 'string') ||
      typeof parsed.stagedVersionId !== 'string' ||
      parsed.stagedVersionId === '' ||
      typeof parsed.workerName !== 'string' ||
      parsed.workerName === '' ||
      metadata?.schema !== 2
    ) {
      return null;
    }
    return {
      previousTriggers: metadata.triggerConfig,
      previousVersionId: parsed.previousVersionId,
      stagedVersionId: parsed.stagedVersionId,
      workerName: parsed.workerName,
    };
  } catch {
    return null;
  }
}

function interruptedWorkerCutover(
  manifest: PlatformInstallationManifest,
): InterruptedWorkerCutover | null {
  const generations = new Map<
    number,
    {
      resolved: boolean;
      staged: Map<
        PlatformWorkerKey,
        {
          previousVersionId: string | null;
          previousTriggers: CloudflareTriggerConfig;
          stagedVersionId: string;
          workerName: string;
        }
      >;
    }
  >();
  for (const step of manifest.steps) {
    const resolution = /^worker-cutover:(\d+):(committed|restored)$/.exec(step.key);
    if (resolution) {
      const generation = Number(resolution[1]);
      const entry = generations.get(generation) ?? { resolved: false, staged: new Map() };
      entry.resolved = true;
      generations.set(generation, entry);
      continue;
    }
    const staged = /^worker-cutover:(\d+):staged:(api|proxy|tail|dispatch)$/.exec(step.key);
    if (!staged) {
      continue;
    }
    const generation = Number(staged[1]);
    const snapshot = parseWorkerCutoverSnapshot(step.resultHash);
    if (!snapshot) {
      throw new Error(`platform: Invalid Worker cutover checkpoint ${step.key}.`);
    }
    const entry = generations.get(generation) ?? { resolved: false, staged: new Map() };
    entry.staged.set(staged[2] as PlatformWorkerKey, snapshot);
    generations.set(generation, entry);
  }
  const unresolved = [...generations.entries()]
    .filter(([, entry]) => !entry.resolved && entry.staged.size > 0)
    .sort(([left], [right]) => right - left)[0];
  return unresolved ? { generation: unresolved[0], staged: unresolved[1].staged } : null;
}

function recordWorkerTrafficState(
  manifest: PlatformInstallationManifest,
  generation: number,
  enabled: boolean,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-traffic-state:${generation}`,
      resultHash: enabled ? 'enabled' : 'disabled',
    },
    completedAt,
  );
}

export function stablePublicEndpointState(existing: PlatformInstallationManifest | null): boolean {
  if (!existing) {
    return false;
  }
  // `void platform disable` removes traffic without redeploying Workers, so it
  // does not create a Worker cutover marker. Its durable desired state is
  // authoritative over the last successful install/upgrade marker.
  if (existing.status === 'disabled' || existing.desiredState === 'disabled') {
    return false;
  }
  const latest = existing.steps
    .flatMap((step) => {
      const match = /^worker-traffic-state:(\d+)$/.exec(step.key);
      return match ? [{ generation: Number(match[1]), state: step.resultHash }] : [];
    })
    .sort((left, right) => right.generation - left.generation)[0];
  if (latest) {
    return latest.state === 'enabled';
  }
  return existing.status === 'installed' || existing.desiredState === 'enabled';
}

export function resolvePlatformPreviousTriggerConfig(
  versionSnapshot: CloudflareTriggerConfig,
  configuredSnapshot: CloudflareTriggerConfig,
  publicEndpoints: boolean,
): CloudflareTriggerConfig {
  if (publicEndpoints) {
    return versionSnapshot;
  }
  // Disable removes public traffic without uploading a new immutable Worker
  // version, so the active version message can still describe the last enabled
  // routes. The durable lifecycle state owns those three traffic fields while
  // the version message remains authoritative for cron, queue, and workflow
  // triggers that disable does not change.
  return {
    ...versionSnapshot,
    preview_urls: configuredSnapshot.preview_urls,
    routes: configuredSnapshot.routes,
    workers_dev: configuredSnapshot.workers_dev,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function verifyPlatformHealth(
  apiUrl: string,
  installationId: string,
  proxyUrl: string,
  applicationBaseDomain: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const request = (url: string, headers?: HeadersInit) =>
    fetcher(url, { headers, signal: AbortSignal.timeout(30_000) });
  const [health, discovery, proxy, dispatch] = await Promise.all([
    request(`${apiUrl}/health`),
    request(`${apiUrl}/.well-known/void-platform`),
    request(`${proxyUrl}/health`),
    request(`https://test.${applicationBaseDomain}/health`, {
      'X-Health-Check': 'void-admin',
    }),
  ]);
  if (!health.ok) {
    throw new Error(`platform: Health check failed at ${apiUrl} (HTTP ${health.status}).`);
  }
  if (!discovery.ok) {
    throw new Error(`platform: Discovery check failed at ${apiUrl} (HTTP ${discovery.status}).`);
  }
  const body = (await discovery.json()) as { installationId?: unknown };
  if (body.installationId !== installationId) {
    throw new Error('platform: Deployed API discovery identity does not match this installation.');
  }
  if (!proxy.ok) {
    throw new Error(`platform: Proxy health check failed at ${proxyUrl} (HTTP ${proxy.status}).`);
  }
  if (!dispatch.ok) {
    throw new Error(
      `platform: Dispatch health check failed at https://test.${applicationBaseDomain} (HTTP ${dispatch.status}).`,
    );
  }
}
