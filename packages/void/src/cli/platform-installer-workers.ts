import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  encodeCloudflareVersionMessage,
  parseCloudflareVersionMessage,
  readCloudflareVersionMigrationTag,
  readCloudflareTriggerConfig,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
  type CloudflareOperation,
  type CloudflareCommandRunner,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import {
  createPlatformResourceOwnershipMarker,
  createPlatformWorkerConfigs,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  recordInstallationStep,
  type PlatformInstallationManifest,
} from '@void/platform';
import { dirname, join, resolve } from 'pathslash';
import {
  PlatformWorkerCustomDomainsChangedError,
  PlatformWorkerRoutesChangedError,
  type CloudflareWorkerCustomDomainOrigin,
} from './platform-cloudflare.ts';
import {
  inventoryUnmanagedPlatformWorkerTraffic,
  mergePlatformWorkerTrafficConfig,
  isolatePlatformWorkerCustomDomains,
  mergePreservedTriggerRoutes,
  withoutPlatformCustomDomainTriggers,
  publishPlatformWorkerCustomDomains,
  requireId,
  validateReplannedWorkerActions,
  withoutPlatformWorkerTrafficAttachments,
} from './platform-installer-resources.ts';
import {
  type PlatformInstallerDependencies,
  type InstallationCheckpointWriter,
  type PlatformWorkerKey,
  type PlatformWorkerDeploymentOptions,
  type PlatformWorkerRollback,
  type PlatformWorkerDeployment,
  PlatformWorkerRecoveryIncompleteError,
  type ConditionalWorkerCreateProxy,
  type ConditionalWorkerCreateState,
  type WorkerInspectionClient,
  type PlatformWorkerCutoverSnapshot,
  type InterruptedWorkerCutover,
} from './platform-installer-types.ts';
import { type PlatformInstallPlan, type PlatformInstallPlanAction } from './platform-plan.ts';
import {
  latestPlatformWorkerCutoverGeneration,
  writeInstallationManifest,
} from './platform-registry.ts';
import { trackedPlatformWorkerTraffic } from './platform-traffic.ts';
import { platformWorkerLiveTriggersMatch } from './platform-trigger-proof.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';
import { createDefaultRunWrangler, resolvePinnedApiBaseUrl } from './provision.ts';

// Restore staged Workers before starting a new generation, then replan any
// newly created Worker that recovery had to retain.
export async function recoverInterruptedPlatformWorkerCutover(
  manifest: PlatformInstallationManifest,
  interruptedCutover: NonNullable<ReturnType<typeof interruptedWorkerCutover>> | null,
  workerActions: ReadonlyArray<PlatformInstallPlanAction>,
  configs: ReturnType<typeof createPlatformWorkerConfigs>,
  previousConfigs: ReturnType<typeof createPlatformWorkerConfigs>,
  plan: PlatformInstallPlan,
  dependencies: PlatformInstallerDependencies,
  ids: Record<string, string>,
  zoneId: string,
  previousPublicEndpoints: boolean,
  hasEmailGatewayArtifact: boolean,
  runPinnedPlatformWrangler: typeof runPlatformWrangler,
  now: () => string,
  writeRemoteInstallationCheckpoint: InstallationCheckpointWriter,
  onManifestChange: (manifest: PlatformInstallationManifest) => void,
): Promise<{
  manifest: PlatformInstallationManifest;
  workerActions: ReadonlyArray<PlatformInstallPlanAction>;
}> {
  if (interruptedCutover) {
    const recoveryOrder: ReadonlyArray<PlatformWorkerKey> = [
      'dispatch',
      'tail',
      'emailGateway',
      'proxy',
      'api',
    ];
    for (const key of recoveryOrder.filter((key) => interruptedCutover.staged.has(key))) {
      const snapshot = interruptedCutover.staged.get(key)!;
      const preservedRoutes = dependencies.recoverWorkerCutover
        ? []
        : await inventoryUnmanagedPlatformWorkerTraffic(
            dependencies.client,
            plan,
            snapshot.workerName,
          );
      const recoveryConfig = mergePlatformWorkerTrafficConfig(
        { ...configs[key], name: snapshot.workerName },
        preservedRoutes,
      );
      const previousRecoveryConfig = mergePlatformWorkerTrafficConfig(
        { ...previousConfigs[key], name: snapshot.workerName },
        preservedRoutes,
      );
      if (dependencies.recoverWorkerCutover) {
        await dependencies.recoverWorkerCutover({
          key,
          preserveCustomDomains: interruptedCutover.unsafeTraffic.has(key),
          previousVersionId: snapshot.previousVersionId,
          stagedVersionId: snapshot.stagedVersionId,
          workerName: snapshot.workerName,
        });
      } else {
        const recoveryTraffic = isolatePlatformWorkerCustomDomains(recoveryConfig);
        const previousRecoveryTraffic = isolatePlatformWorkerCustomDomains(previousRecoveryConfig);
        await rollbackPlatformWorker({
          accountId: plan.account.id,
          activatedDeploymentId: null,
          activatedVersionId: snapshot.stagedVersionId,
          config: recoveryConfig,
          nextTriggers: readTriggerConfigFromObject(recoveryTraffic.wranglerConfig),
          previousConfig: previousRecoveryConfig,
          previousCustomDomains: previousRecoveryTraffic.customDomains,
          previousDeployment: null,
          previousTriggers: mergePreservedTriggerRoutes(
            withoutPlatformCustomDomainTriggers(snapshot.previousTriggers),
            preservedRoutes,
          ),
          previousVersionId: snapshot.previousVersionId,
          preserveCustomDomains: interruptedCutover.unsafeTraffic.has(key),
          inspectNewWorker: () =>
            inspectNewPlatformWorker(
              dependencies.client,
              plan.account.id,
              manifest!,
              key === 'emailGateway' ? 'email-gateway-worker' : `${key}-worker`,
              snapshot.workerName,
            ),
          removeCustomDomains: async () => {
            if (!dependencies.client.removeRoutes) {
              throw new Error('platform: Cloudflare route removal is unavailable.');
            }
            await dependencies.client.removeRoutes(
              plan.account.id,
              zoneId,
              trackedPlatformWorkerTraffic(manifest!, new Set([snapshot.workerName])),
            );
          },
          publishCustomDomains: (workerName, origins) =>
            publishPlatformWorkerCustomDomains(
              dependencies.client,
              plan.account.id,
              workerName,
              origins,
            ),
          retainNewWorker: async () => {
            await dependencies.client.putKvValue(
              plan.account.id,
              requireId(ids, 'routing-kv'),
              PLATFORM_DISABLED_KEY,
              PLATFORM_DISABLED_VALUE,
            );
          },
          runner: runPinnedPlatformWrangler,
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
      previousPublicEndpoints && interruptedCutover.unsafeTraffic.size === 0,
      now(),
    );
    let retainedNewWorker = false;
    for (const [, snapshot] of interruptedCutover.staged) {
      if (snapshot.previousVersionId !== null) {
        continue;
      }
      retainedNewWorker = true;
    }
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    if (retainedNewWorker) {
      if (!dependencies.replanWorkers) {
        throw new Error(
          'platform: Recovering retained Workers requires a fresh Cloudflare installation plan.',
        );
      }
      workerActions = validateReplannedWorkerActions(
        plan,
        manifest,
        await dependencies.replanWorkers(manifest),
      ).filter((action) => hasEmailGatewayArtifact || action.key !== 'email-gateway-worker');
    }
  }
  return { manifest, workerActions };
}

let cachedPlatformUploaderHash: string | null | undefined;

function platformWorkerUploaderHash(): string | null {
  if (cachedPlatformUploaderHash !== undefined) {
    return cachedPlatformUploaderHash;
  }
  try {
    const launcher = resolveCloudflareOperationArgv(process.cwd())[1];
    if (!launcher) {
      return (cachedPlatformUploaderHash = null);
    }
    const digest = createHash('sha256');
    digest.update('platform-uploader:v1\0');
    digest.update(process.version);
    digest.update(readFileSync(launcher));
    digest.update(readFileSync(resolve(dirname(launcher), '..', '..', 'package.json')));
    const cfDirectory = dirname(fileURLToPath(import.meta.resolve('cf/package.json')));
    digest.update(readFileSync(join(cfDirectory, 'package.json')));
    digest.update(readFileSync(join(cfDirectory, 'bin', 'cf')));
    const cfCodeHash = platformWorkerDirectoryHash(join(cfDirectory, 'dist'));
    if (!cfCodeHash) {
      throw new Error('Cloudflare CLI code is unavailable.');
    }
    digest.update(cfCodeHash);
    let dependencyDirectory = dirname(
      fileURLToPath(import.meta.resolve('@cloudflare/build-output-utils')),
    );
    while (!existsSync(join(dependencyDirectory, 'package.json'))) {
      const parent = dirname(dependencyDirectory);
      if (parent === dependencyDirectory) {
        throw new Error('Cloudflare build output package is unavailable.');
      }
      dependencyDirectory = parent;
    }
    digest.update(readFileSync(join(dependencyDirectory, 'package.json')));
    const buildOutputCodeHash = platformWorkerDirectoryHash(join(dependencyDirectory, 'dist'));
    if (!buildOutputCodeHash) {
      throw new Error('Cloudflare build output code is unavailable.');
    }
    digest.update(buildOutputCodeHash);
    const visited = new Set<string>();
    const visit = (path: string, name: string) => {
      if (visited.has(path)) {
        return;
      }
      visited.add(path);
      const source = readFileSync(path);
      digest.update(`${name}\0`);
      digest.update(source);
      const imports = [
        ...source
          .toString('utf8')
          .matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g),
      ]
        .map((match) => match[1]!)
        .sort();
      for (const specifier of imports) {
        visit(resolve(dirname(path), specifier), specifier);
      }
    };
    visit(launcher, 'launcher');
    return (cachedPlatformUploaderHash = digest.digest('hex'));
  } catch {
    return (cachedPlatformUploaderHash = null);
  }
}

function platformWorkerDirectoryHash(directory: string): string | null {
  if (!lstatSync(directory).isDirectory()) {
    return null;
  }
  const digest = createHash('sha256');
  const visit = (path: string, prefix: string): boolean => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relativePath = `${prefix}${entry.name}`;
      const absolutePath = join(path, entry.name);
      if (entry.isDirectory()) {
        digest.update(`directory:${relativePath}\0`);
        if (!visit(absolutePath, `${relativePath}/`)) {
          return false;
        }
      } else if (entry.isFile()) {
        digest.update(`file:${relativePath}\0`);
        digest.update(createHash('sha256').update(readFileSync(absolutePath)).digest('hex'));
      } else {
        return false;
      }
    }
    return true;
  };
  return visit(directory, '') ? digest.digest('hex') : null;
}

/** Hash every input that can change a version upload; missing or unusual files disable reuse. */
export function platformWorkerUploadFingerprint(
  config: Record<string, unknown>,
  managedRoutes: ReadonlyArray<string> = [],
): string | null {
  const uploaderHash = platformWorkerUploaderHash();
  if (typeof config.main !== 'string' || !uploaderHash) {
    return null;
  }
  try {
    const main = lstatSync(config.main);
    if (!main.isFile()) {
      return null;
    }
    const mainSha256 = createHash('sha256').update(readFileSync(config.main)).digest('hex');
    const normalized: Record<string, unknown> = { ...config, main: { sha256: mainSha256 } };
    if (config.assets !== undefined) {
      const assets = config.assets;
      if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
        return null;
      }
      const directory = (assets as Record<string, unknown>).directory;
      if (typeof directory !== 'string') {
        return null;
      }
      const assetsHash = platformWorkerDirectoryHash(directory);
      if (!assetsHash) {
        return null;
      }
      normalized.assets = {
        ...(assets as Record<string, unknown>),
        directory: assetsHash,
      };
    }
    return createHash('sha256')
      .update(JSON.stringify({ schema: 2, config: normalized, managedRoutes, uploaderHash }))
      .digest('hex');
  } catch {
    return null;
  }
}

function snapshotPlatformWorkerUploadInputs(
  config: Record<string, unknown>,
  directory: string,
): Record<string, unknown> {
  const main = config.main;
  if (typeof main !== 'string') {
    throw new Error('platform: Worker upload has no script artifact.');
  }
  const snapshotMain = join(directory, 'worker-upload.js');
  copyFileSync(main, snapshotMain);
  const snapshot: Record<string, unknown> = { ...config, main: snapshotMain };
  if (config.assets !== undefined) {
    const assets = config.assets as Record<string, unknown>;
    const sourceDirectory = assets.directory;
    if (typeof sourceDirectory !== 'string') {
      throw new Error('platform: Worker upload has no assets directory.');
    }
    const snapshotDirectory = join(directory, 'worker-assets');
    cpSync(sourceDirectory, snapshotDirectory, { recursive: true });
    snapshot.assets = { ...assets, directory: snapshotDirectory };
  }
  return snapshot;
}

function platformWorkerApiReadRunner(
  accountId: string,
  workerName: string,
  readCloudflare: (path: string) => Promise<unknown>,
  fallback: typeof runPlatformWrangler,
): typeof runPlatformWrangler {
  const base = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
  return async (operation, account, cwd, capture) => {
    try {
      if (operation.type === 'deployments.status' || operation.type === 'deployments.list') {
        const response = await readCloudflare(`${base}/deployments`);
        const deployments =
          response && typeof response === 'object' && !Array.isArray(response)
            ? (response as { deployments?: unknown }).deployments
            : null;
        if (!Array.isArray(deployments)) {
          throw new Error(
            `platform: Cloudflare returned malformed deployment history for ${workerName}.`,
          );
        }
        return {
          status: operation.type === 'deployments.status' && deployments.length === 0 ? 1 : 0,
          stderr: '',
          stdout: '',
          data: operation.type === 'deployments.status' ? deployments[0] : deployments,
        };
      }
      if (operation.type === 'versions.view') {
        const version = await readCloudflare(
          `${base}/versions/${encodeURIComponent(operation.versionId)}`,
        );
        return { status: 0, stderr: '', stdout: '', data: version };
      }
    } catch {
      // A failed read is not evidence of ownership or deployment lineage.
      // Keep the same provider check through the scoped operation runner.
    }
    return fallback(operation, account, cwd, capture);
  };
}

export async function deployPlatformWorker(
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  options: PlatformWorkerDeploymentOptions,
): Promise<PlatformWorkerRollback | null> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-deploy-'));
  const workerName = String(config.name);
  const accountId = String(config.account_id);
  const readRunner = options.readCloudflare
    ? platformWorkerApiReadRunner(accountId, workerName, options.readCloudflare, options.runner)
    : options.runner;
  let activatedVersionId: string | null = null;
  let activatedDeploymentId: string | null = null;
  let uploadedVersionId: string | null = null;
  let previousDeployment: PlatformWorkerDeployment | null = null;
  let previousDeploymentId: string | null = null;
  let previousVersionId: string | null = null;
  const nextTraffic = isolatePlatformWorkerCustomDomains(config);
  const previousTraffic = isolatePlatformWorkerCustomDomains(options.previousConfig);
  let uploadConfig = withoutPlatformWorkerTrafficAttachments(nextTraffic.wranglerConfig);
  const nextTriggers = readTriggerConfigFromObject(nextTraffic.wranglerConfig);
  const contentHash =
    secrets === null ? platformWorkerUploadFingerprint(config, options.managedRoutes) : null;
  const reuseMatchingVersion = options.reuseMatchingVersion !== false;
  let previousTriggers = readTriggerConfigFromObject(previousTraffic.wranglerConfig);
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const reconcileExistingVersion = async (
      versionId: string,
      triggerConfig: CloudflareTriggerConfig,
      runner: typeof runPlatformWrangler,
      deploymentId?: string,
    ): Promise<null> => {
      // A reused version still needs its mutable traffic state reconciled.
      try {
        const liveTriggersMatch =
          deploymentId && options.readCloudflare
            ? await platformWorkerLiveTriggersMatch({
                accountId,
                workerName,
                desired: nextTriggers,
                readCloudflare: options.readCloudflare,
              })
            : false;
        if (liveTriggersMatch) {
          const beforeTraffic = await readPlatformWorkerDeployments(
            configPath,
            accountId,
            workerName,
            runner,
          );
          if (
            beforeTraffic[0]?.id !== deploymentId ||
            !deploymentRunsOnlyVersion(beforeTraffic[0], versionId)
          ) {
            throw new Error(
              `platform: Worker ${workerName} changed deployment lineage during trigger verification.`,
            );
          }
        } else {
          const triggers = await stabilizeCloudflareVersionTriggers({
            configPath,
            knownTriggerConfigs: { [versionId]: nextTriggers },
            manageRoutes: false,
            previousTriggerConfig: triggerConfig,
            publishEmptyCustomDomains: async () => {
              await options.removeCustomDomains();
              return cleanPlatformCommandResult();
            },
            runWrangler: platformWorkerCommandRunner(accountId, directory, runner),
            targetTriggerConfig: nextTriggers,
            targetVersionId: versionId,
            workerName,
          });
          assertPlatformTriggerStabilization(triggers, workerName, versionId, 'publish');
        }
        if (nextTraffic.customDomains.length > 0) {
          await options.publishCustomDomains(workerName, nextTraffic.customDomains);
        }
        if (options.managedRoutes.length > 0) {
          await options.publishRoutes(workerName, options.managedRoutes);
        }
        await options.onTrafficPublished();
        if (
          !deploymentId &&
          (await readActivePlatformWorkerVersion(configPath, accountId, workerName, runner)) !==
            versionId
        ) {
          throw new Error(`platform: Worker ${workerName} changed during traffic reconciliation.`);
        }
        if (deploymentId) {
          const after = await readPlatformWorkerDeployments(
            configPath,
            accountId,
            workerName,
            runner,
          );
          if (after[0]?.id !== deploymentId || !deploymentRunsOnlyVersion(after[0], versionId)) {
            throw new Error(
              `platform: Worker ${workerName} changed deployment lineage during reconciliation.`,
            );
          }
        }
        return null;
      } catch (error) {
        const failures = await recoverFailedPlatformWorkerDeployment({
          checkpointUnsafeTraffic: options.onUnsafeTraffic,
          closeRoutingGate: options.retainNewWorker,
          rollback: null,
          unsafeTraffic: true,
        });
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} traffic reconciliation failed: ${errorMessage(error)}${
            failures.length > 0 ? ` Safety recovery also failed: ${failures.join('; ')}` : ''
          }`,
          { cause: error },
        );
      }
    };
    if (options.workerExisted && contentHash && reuseMatchingVersion && options.readCloudflare) {
      let candidate:
        | {
            deploymentId: string;
            snapshot: Awaited<ReturnType<typeof readActivePlatformWorkerSnapshot>>;
          }
        | undefined;
      let changedDuringRead = false;
      try {
        const before = await readPlatformWorkerDeployments(
          configPath,
          accountId,
          workerName,
          readRunner,
        );
        const activeVersion =
          before[0]?.versions.length === 1 && before[0].versions[0]?.percentage === 100
            ? before[0].versions[0].versionId
            : null;
        if (!activeVersion) {
          throw new Error(
            `platform: Existing Worker ${workerName} has no single active production version.`,
          );
        }
        const snapshot = await readPlatformWorkerVersionSnapshot(
          configPath,
          accountId,
          workerName,
          readPlatformWorkerOwnershipMarker(config),
          activeVersion,
          readRunner,
        );
        const after = await readPlatformWorkerDeployments(
          configPath,
          accountId,
          workerName,
          readRunner,
        );
        changedDuringRead =
          before[0]?.id !== after[0]?.id ||
          !deploymentRunsOnlyVersion(after[0], snapshot.versionId);
        if (!changedDuringRead && snapshot.contentHash === contentHash) {
          candidate = { deploymentId: after[0]!.id, snapshot };
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('changed concurrently') ||
            error.message.includes('does not belong to this installation'))
        ) {
          throw error;
        }
        // A read error is not evidence of equality; use the established upload path.
      }
      if (changedDuringRead) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its deployment lineage was inspected.`,
        );
      }
      if (
        candidate &&
        platformWorkerUploadFingerprint(config, options.managedRoutes) === contentHash
      ) {
        await options.onReadyForActivation?.();
        await options.waitForPriorWorker?.();
        return await reconcileExistingVersion(
          candidate.snapshot.versionId,
          candidate.snapshot.triggerConfig,
          readRunner,
          candidate.deploymentId,
        );
      }
    }
    if (options.workerExisted) {
      const previous = await readActivePlatformWorkerSnapshot(
        configPath,
        accountId,
        workerName,
        readPlatformWorkerOwnershipMarker(config),
        readRunner,
      );
      previousVersionId = previous.versionId;
      const deployments = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        readRunner,
      );
      if (!deploymentRunsOnlyVersion(deployments[0], previousVersionId)) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its deployment lineage was inspected.`,
        );
      }
      previousDeployment = deployments[0]!;
      previousDeploymentId = previousDeployment.id;
      if (
        contentHash &&
        reuseMatchingVersion &&
        previous.contentHash === contentHash &&
        platformWorkerUploadFingerprint(config, options.managedRoutes) === contentHash
      ) {
        await options.onReadyForActivation?.();
        await options.waitForPriorWorker?.();
        return await reconcileExistingVersion(
          previousVersionId,
          previous.triggerConfig,
          readRunner,
        );
      }
      uploadConfig = withoutCompletedPlatformWorkerMigrations(uploadConfig, previous.migrationTag);
      writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, {
        mode: 0o600,
      });
      previousTriggers = resolvePlatformPreviousTriggerConfig(
        withoutPlatformCustomDomainTriggers(previous.triggerConfig),
        previousTriggers,
        options.previousPublicEndpoints,
      );
      previousTriggers = withoutPlatformCustomDomainTriggers(
        mergePreservedTriggerRoutes(previousTriggers, options.preservedRoutes),
      );
    }
    const immutableConfig = contentHash
      ? snapshotPlatformWorkerUploadInputs(config, directory)
      : null;
    const uploadedContentHash = immutableConfig
      ? platformWorkerUploadFingerprint(immutableConfig, options.managedRoutes)
      : null;
    if (immutableConfig) {
      uploadConfig = {
        ...uploadConfig,
        main: immutableConfig.main,
        ...(immutableConfig.assets === undefined ? {} : { assets: immutableConfig.assets }),
      };
      writeFileSync(configPath, `${JSON.stringify(uploadConfig, null, 2)}\n`, { mode: 0o600 });
    }
    const operation: CloudflareOperation = {
      type: options.workerExisted ? 'versions.upload' : 'worker.deploy',
      configPath,
      message: encodeCloudflareVersionMessage([], nextTriggers, uploadedContentHash ?? undefined),
    };
    if (secrets) {
      const secretsPath = join(directory, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
      operation.secretsFilePath = secretsPath;
    }
    const releaseUploadSlot = await options.acquireUploadSlot?.();
    let uploaded: CloudflareCommandResult;
    let uploadError: unknown;
    try {
      uploaded = options.workerExisted
        ? await options.runner(operation, accountId, directory, true)
        : await runPlatformWranglerForConditionalCreate(
            operation,
            accountId,
            directory,
            true,
            workerName,
            options.apiBaseUrl,
          );
      assertCleanPlatformWrangler(
        uploaded,
        `${options.workerExisted ? 'upload' : 'bootstrap'} ${workerName}`,
      );
    } catch (error) {
      uploadError = error;
      throw error;
    } finally {
      releaseUploadSlot?.(uploadError);
    }
    const uploadData = uploaded.data as { versionId?: unknown } | undefined;
    uploadedVersionId = typeof uploadData?.versionId === 'string' ? uploadData.versionId : null;
    if (!options.workerExisted) {
      activatedVersionId = uploadedVersionId;
    }
    if (!uploadedVersionId) {
      throw new Error(
        `platform: Wrangler uploaded ${workerName} without reporting its immutable version id.`,
      );
    }
    await options.onStaged(previousVersionId, uploadedVersionId, previousTriggers);
    await options.onReadyForActivation?.();
    await options.waitForPriorWorker?.();
    if (options.workerExisted) {
      const deploymentsBeforeActivation = await readPlatformWorkerDeployments(
        configPath,
        accountId,
        workerName,
        readRunner,
      );
      if (
        deploymentsBeforeActivation[0]?.id !== previousDeploymentId ||
        !deploymentRunsOnlyVersion(deploymentsBeforeActivation[0], previousVersionId)
      ) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently before activation; refusing to overwrite it.`,
        );
      }
      activatedVersionId = uploadedVersionId;
      const activated = await options.runner(
        {
          type: 'versions.deploy',
          configPath,
          versions: [{ versionId: uploadedVersionId, percentage: 100 }],
          message: `Void platform activation ${uploadedVersionId}`,
        },
        accountId,
        directory,
        true,
      );
      assertCleanPlatformWrangler(activated, `activate ${workerName}`);
    }
    const deploymentsAfterActivation = await readPlatformWorkerDeployments(
      configPath,
      accountId,
      workerName,
      readRunner,
    );
    const lineage = classifyPlatformWorkerDeploymentLineage(
      deploymentsAfterActivation,
      uploadedVersionId,
      previousDeploymentId,
    );
    if (lineage.kind === 'concurrent-after') {
      activatedVersionId = null;
      throw new Error(
        `platform: Worker ${workerName} changed concurrently after activation; refusing to overwrite the newer deployment.`,
      );
    }
    activatedDeploymentId = lineage.deploymentId;
    if (lineage.kind === 'intervening') {
      const interveningDeployment = deploymentsAfterActivation[1];
      activatedVersionId = null;
      activatedDeploymentId = null;
      if (!interveningDeployment) {
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} lost its previous deployment during activation. The cutover cannot be recovered automatically.`,
        );
      }
      try {
        await restorePlatformWorkerDeployment({
          accountId,
          configPath,
          directory,
          expectedActiveDeploymentId: lineage.deploymentId,
          expectedActiveVersionId: uploadedVersionId,
          restoration: interveningDeployment,
          runner: readRunner,
          workerName,
        });
      } catch (recoveryError) {
        const recoveryFailures = await recoverFailedPlatformWorkerDeployment({
          checkpointUnsafeTraffic: options.onUnsafeTraffic,
          closeRoutingGate: options.retainNewWorker,
          rollback: null,
          unsafeTraffic: true,
        });
        throw new PlatformWorkerRecoveryIncompleteError(
          `platform: Worker ${workerName} changed concurrently during activation, and restoring intervening deployment ${interveningDeployment.id} failed: ${errorMessage(recoveryError)}${
            recoveryFailures.length > 0
              ? ` Safety recovery also failed: ${recoveryFailures.join('; ')}`
              : ''
          }`,
          { cause: recoveryError },
        );
      }
      throw new Error(
        `platform: Worker ${workerName} changed concurrently during activation. The intervening deployment was restored without deleting deployment history.`,
      );
    }
    const triggers = await stabilizeCloudflareVersionTriggers({
      configPath,
      knownTriggerConfigs: {
        [uploadedVersionId]: nextTriggers,
        ...(previousVersionId ? { [previousVersionId]: previousTriggers } : {}),
      },
      manageRoutes: false,
      previousTriggerConfig: previousTriggers,
      publishEmptyCustomDomains: async () => {
        await options.removeCustomDomains();
        return cleanPlatformCommandResult();
      },
      runWrangler: platformWorkerCommandRunner(accountId, directory, readRunner),
      targetTriggerConfig: nextTriggers,
      targetVersionId: uploadedVersionId,
      workerName,
    });
    assertPlatformTriggerStabilization(triggers, workerName, uploadedVersionId, 'publish');
    if (nextTraffic.customDomains.length > 0) {
      await options.publishCustomDomains(workerName, nextTraffic.customDomains);
    }
    if (options.managedRoutes.length > 0) {
      await options.publishRoutes(workerName, options.managedRoutes);
    }
    await options.onTrafficPublished();
    const rollback = () =>
      rollbackPlatformWorker({
        accountId,
        activatedDeploymentId,
        activatedVersionId: uploadedVersionId!,
        config,
        nextTriggers,
        previousConfig: options.previousConfig,
        previousCustomDomains: previousTraffic.customDomains,
        previousDeployment,
        previousTriggers,
        previousVersionId,
        preserveCustomDomains: false,
        inspectNewWorker: options.inspectNewWorker,
        removeCustomDomains: options.removeCustomDomains,
        publishCustomDomains: options.publishCustomDomains,
        retainNewWorker: options.retainNewWorker,
        runner: readRunner,
        workerExisted: options.workerExisted,
        workerName,
      });
    return rollback;
  } catch (error) {
    const unsafeTraffic =
      error instanceof PlatformWorkerCustomDomainsChangedError ||
      error instanceof PlatformWorkerRoutesChangedError;
    const rollbackVersionId = activatedVersionId && uploadedVersionId ? uploadedVersionId : null;
    const recoveryFailures = await recoverFailedPlatformWorkerDeployment({
      checkpointUnsafeTraffic: options.onUnsafeTraffic,
      closeRoutingGate: options.retainNewWorker,
      rollback: rollbackVersionId
        ? () =>
            rollbackPlatformWorker({
              accountId,
              activatedDeploymentId,
              activatedVersionId: rollbackVersionId,
              config,
              nextTriggers: readTriggerConfigFromObject(nextTraffic.wranglerConfig),
              previousConfig: options.previousConfig,
              previousCustomDomains: previousTraffic.customDomains,
              previousDeployment,
              previousTriggers,
              previousVersionId,
              preserveCustomDomains: unsafeTraffic,
              inspectNewWorker: options.inspectNewWorker,
              removeCustomDomains: options.removeCustomDomains,
              publishCustomDomains: options.publishCustomDomains,
              retainNewWorker: options.retainNewWorker,
              runner: readRunner,
              workerExisted: options.workerExisted,
              workerName,
            })
        : null,
      unsafeTraffic,
    });
    if (recoveryFailures.length > 0) {
      throw new PlatformWorkerRecoveryIncompleteError(
        `platform: ${errorMessage(error)} Automatic recovery for ${workerName} was incomplete: ${recoveryFailures.join('; ')}`,
        { cause: error },
      );
    }
    if (unsafeTraffic) {
      throw new PlatformWorkerRecoveryIncompleteError(
        `platform: ${errorMessage(error)} The routing gate remains closed and live Custom Domains were retained for safe reconciliation on retry.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function recoverFailedPlatformWorkerDeployment(input: {
  checkpointUnsafeTraffic: () => Promise<void>;
  closeRoutingGate: () => Promise<void>;
  rollback: (() => Promise<void>) | null;
  unsafeTraffic: boolean;
}): Promise<Array<string>> {
  const failures: Array<string> = [];
  const attempt = async (label: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  };
  if (input.unsafeTraffic) {
    await attempt('closing the routing gate failed', input.closeRoutingGate);
    await attempt('checkpointing unsafe traffic failed', input.checkpointUnsafeTraffic);
  }
  if (input.rollback) {
    await attempt('Worker rollback failed', input.rollback);
  }
  return failures;
}

async function rollbackPlatformWorker(input: {
  accountId: string;
  activatedDeploymentId: string | null;
  activatedVersionId: string;
  config: Record<string, unknown>;
  nextTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousConfig: Record<string, unknown>;
  previousCustomDomains: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>;
  previousDeployment: PlatformWorkerDeployment | null;
  previousTriggers: ReturnType<typeof readCloudflareTriggerConfig>;
  previousVersionId: string | null;
  preserveCustomDomains: boolean;
  inspectNewWorker: () => Promise<'missing' | 'owned'>;
  removeCustomDomains: () => Promise<void>;
  publishCustomDomains: (
    workerName: string,
    origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
  ) => Promise<void>;
  retainNewWorker: () => Promise<void>;
  runner: typeof runPlatformWrangler;
  workerExisted: boolean;
  workerName: string;
}): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-rollback-'));
  try {
    const configPath = join(directory, 'wrangler.json');
    const currentTraffic = isolatePlatformWorkerCustomDomains(input.config);
    writeFileSync(configPath, `${JSON.stringify(currentTraffic.wranglerConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    if (!input.workerExisted) {
      if ((await input.inspectNewWorker()) === 'missing') {
        return;
      }
      const currentVersionId = await readActivePlatformWorkerVersion(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      if (currentVersionId !== input.activatedVersionId) {
        throw new Error(
          `Worker ${input.workerName} changed concurrently from installer version ${input.activatedVersionId} to ${currentVersionId ?? 'no active version'}; refusing to delete it.`,
        );
      }
      if ((await input.inspectNewWorker()) === 'missing') {
        return;
      }
      await input.retainNewWorker();
      if (!input.preserveCustomDomains) {
        await input.removeCustomDomains();
      }
      return;
    }
    const currentVersionId = await readActivePlatformWorkerVersion(
      configPath,
      input.accountId,
      input.workerName,
      input.runner,
    );
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
      const currentDeployments = await readPlatformWorkerDeployments(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      const activeDeploymentId = input.activatedDeploymentId ?? currentDeployments[0]?.id ?? null;
      const restoration = input.previousDeployment ?? currentDeployments[1];
      if (
        !activeDeploymentId ||
        currentDeployments[0]?.id !== activeDeploymentId ||
        !deploymentRunsOnlyVersion(currentDeployments[0], input.activatedVersionId) ||
        !restoration ||
        currentDeployments[1]?.id !== restoration.id ||
        !deploymentRunsOnlyVersion(restoration, input.previousVersionId)
      ) {
        throw new Error(
          `Worker ${input.workerName} changed concurrently after installer deployment; refusing to alter its deployment history.`,
        );
      }
      await restorePlatformWorkerDeployment({
        accountId: input.accountId,
        configPath,
        directory,
        expectedActiveDeploymentId: activeDeploymentId,
        expectedActiveVersionId: input.activatedVersionId,
        restoration,
        runner: input.runner,
        workerName: input.workerName,
      });
      const restoredVersionId = await readActivePlatformWorkerVersion(
        configPath,
        input.accountId,
        input.workerName,
        input.runner,
      );
      if (restoredVersionId !== input.previousVersionId) {
        throw new Error(
          `Worker ${input.workerName} did not restore immutable version ${input.previousVersionId} after rolling back installer deployment ${activeDeploymentId}.`,
        );
      }
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
      manageRoutes: false,
      previousTriggerConfig: input.nextTriggers,
      publishEmptyCustomDomains: async () => {
        await input.removeCustomDomains();
        return cleanPlatformCommandResult();
      },
      runWrangler: platformWorkerCommandRunner(input.accountId, directory, input.runner),
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
    if (!input.preserveCustomDomains && input.previousCustomDomains.length > 0) {
      await input.publishCustomDomains(input.workerName, input.previousCustomDomains);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function platformWorkerCommandRunner(
  accountId: string,
  cwd: string,
  runner: typeof runPlatformWrangler,
): CloudflareCommandRunner {
  return (operation, options) => runner(operation, accountId, cwd, options.capture);
}

export async function runPlatformWrangler(
  operation: CloudflareOperation,
  accountId: string,
  cwd: string,
  capture: boolean,
): Promise<CloudflareCommandResult> {
  return runPlatformWranglerAtApiBase(operation, accountId, cwd, capture);
}

const PLATFORM_WRANGLER_TIMEOUT_MS = 10 * 60 * 1000;

export async function runPlatformWranglerAtApiBase(
  operation: CloudflareOperation,
  accountId: string,
  cwd: string,
  capture: boolean,
  apiBaseUrl: string = resolvePinnedApiBaseUrl(),
  parallelWorkerUpload = false,
): Promise<CloudflareCommandResult> {
  const startedAt = performance.now();
  const runner = createDefaultRunWrangler(process.cwd(), {
    launcher: resolveCloudflareOperationArgv(process.cwd()),
    parallelWorkerUpload,
    timeoutMs: PLATFORM_WRANGLER_TIMEOUT_MS,
  });
  const result = await runner(operation, {
    accountId,
    apiBaseUrl,
    cwd,
  });
  if (process.env.VOID_PLATFORM_TIMINGS === '1') {
    process.stderr.write(
      `[platform timing] Cloudflare ${operation.type} ${(performance.now() - startedAt).toFixed(0)} ms\n`,
    );
  }
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  // Void owns progress output. Successful commands may still emit banners and
  // warnings; keep those captured, but retain diagnostics for failed commands.
  if (!capture && result.status !== 0) {
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }
  return { ...result, stderr, stdout };
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
    server.closeAllConnections();
  });
}

async function startConditionalWorkerCreateProxy(
  upstreamApiBaseUrl: string,
  accountId: string,
  workerName: string,
): Promise<ConditionalWorkerCreateProxy> {
  const upstreamBase = new URL(upstreamApiBaseUrl);
  if (upstreamBase.protocol !== 'http:' && upstreamBase.protocol !== 'https:') {
    throw new Error('platform: Cloudflare API base URL must use HTTP or HTTPS.');
  }
  const basePath = upstreamBase.pathname.replace(/\/+$/, '');
  const accountPath = `${basePath}/accounts/${encodeURIComponent(accountId)}`;
  const expectedPath = `${accountPath}/workers/scripts/${encodeURIComponent(workerName)}`;
  const assetUploadPath = `${accountPath}/workers/assets/upload`;
  const state: ConditionalWorkerCreateState = {
    assetSessionStarted: false,
    attempted: false,
    conflictStatus: null,
    created: false,
    forwarded: false,
    rejectedMutation: null,
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const incomingUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      if (incomingUrl.pathname !== basePath && !incomingUrl.pathname.startsWith(`${basePath}/`)) {
        outgoing.writeHead(502, { 'Content-Type': 'application/json' });
        outgoing.end('{"success":false,"errors":[{"message":"Invalid API proxy path"}]}');
        return;
      }
      // Wrangler omits script content from the response and requests strict
      // binding inheritance. These are the only accepted create-query options.
      const createQuery = [...incomingUrl.searchParams];
      const supportedCreateQuery =
        new Set(createQuery.map(([key]) => key)).size === createQuery.length &&
        createQuery.every(
          ([key, value]) =>
            (key === 'excludeScript' && value === 'true') ||
            (key === 'bindings_inherit' && value === 'strict'),
        );
      const isConditionalCreate =
        incoming.method === 'PUT' && incomingUrl.pathname === expectedPath && supportedCreateQuery;
      const isTopLevelWorkerUpload =
        incoming.method === 'PUT' &&
        new RegExp(
          `^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/accounts/[^/]+/workers/scripts/[^/]+$`,
        ).test(incomingUrl.pathname);
      const isReadOnly =
        incoming.method === 'GET' || incoming.method === 'HEAD' || incoming.method === 'OPTIONS';
      // A Worker with static assets must register its asset manifest and upload
      // the missing files before the script PUT that references them. Neither
      // step attaches anything to a Worker; only the guarded create does.
      const isAssetUploadSession =
        incoming.method === 'POST' &&
        incomingUrl.pathname === `${expectedPath}/assets-upload-session` &&
        incomingUrl.search === '';
      const isAssetUpload =
        incoming.method === 'POST' &&
        state.assetSessionStarted &&
        ((incomingUrl.pathname === assetUploadPath && incomingUrl.search === '?base64=true') ||
          (incomingUrl.search === '' &&
            incomingUrl.pathname.startsWith(`${assetUploadPath}/`) &&
            /^[0-9a-f]{32}$/.test(incomingUrl.pathname.slice(assetUploadPath.length + 1))));
      if (
        (isTopLevelWorkerUpload && !isConditionalCreate) ||
        (!isReadOnly &&
          !isConditionalCreate &&
          !isAssetUploadSession &&
          !isAssetUpload &&
          !state.created)
      ) {
        state.rejectedMutation = `${incoming.method ?? 'UNKNOWN'} ${incomingUrl.pathname}${
          incomingUrl.pathname === expectedPath && !supportedCreateQuery
            ? ' (unsupported Worker create query)'
            : ''
        }`;
        incoming.resume();
        outgoing.writeHead(409, { 'Content-Type': 'application/json' });
        outgoing.end(
          '{"success":false,"errors":[{"message":"Mutation blocked until conditional Worker creation succeeds"}]}',
        );
        return;
      }
      const headers = forwardHeaders(incoming.headers);
      delete headers.host;
      if (isConditionalCreate) {
        state.attempted = true;
        headers['if-none-match'] = '*';
      }
      if (isAssetUploadSession) {
        state.assetSessionStarted = true;
      }
      const upstreamUrl = new URL(
        `${incomingUrl.pathname}${incomingUrl.search}`,
        upstreamBase.origin,
      );
      const request = (upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
        upstreamUrl,
        {
          headers,
          method: incoming.method,
        },
        (response) => {
          if (isConditionalCreate) {
            state.forwarded = true;
            if (response.statusCode === 409 || response.statusCode === 412) {
              state.conflictStatus = response.statusCode;
            }
            state.created =
              response.statusCode !== undefined &&
              response.statusCode >= 200 &&
              response.statusCode < 300;
          }
          const responseHeaders = forwardHeaders(response.headers);
          outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
          response.pipe(outgoing);
        },
      );
      request.on('error', () => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502, { 'Content-Type': 'application/json' });
        }
        outgoing.end(
          '{"success":false,"errors":[{"message":"Cloudflare API proxy request failed"}]}',
        );
      });
      incoming.pipe(request);
    })().catch(() => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { 'Content-Type': 'application/json' });
      }
      outgoing.end('{"success":false,"errors":[{"message":"Cloudflare API proxy failed"}]}');
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}${basePath}`,
    close: () => closeHttpServer(server),
    state,
  };
}

export async function withConditionalPlatformWorkerCreate<T>(
  accountId: string,
  workerName: string,
  operation: (apiBaseUrl: string) => Promise<T>,
  upstreamApiBaseUrl: string = resolvePinnedApiBaseUrl(),
): Promise<T> {
  const proxy = await startConditionalWorkerCreateProxy(upstreamApiBaseUrl, accountId, workerName);
  let result: T;
  try {
    result = await operation(proxy.apiBaseUrl);
  } finally {
    await proxy.close();
  }
  if (proxy.state.rejectedMutation) {
    throw new Error(
      `platform: Wrangler attempted unexpected mutation ${proxy.state.rejectedMutation} while conditionally creating new Worker ${workerName}; the mutation was blocked.`,
    );
  }
  if (!proxy.state.attempted || !proxy.state.forwarded) {
    throw new Error(
      `platform: Wrangler did not use the guarded create endpoint for new Worker ${workerName}; refusing an unverified deployment.`,
    );
  }
  if (proxy.state.conflictStatus !== null) {
    throw new Error(
      `platform: Worker ${workerName} was created concurrently (HTTP ${proxy.state.conflictStatus}); no existing Worker was changed. Re-run to inspect the collision.`,
    );
  }
  return result;
}

async function runPlatformWranglerForConditionalCreate(
  operation: CloudflareOperation,
  accountId: string,
  cwd: string,
  capture: boolean,
  workerName: string,
  upstreamApiBaseUrl: string,
): Promise<CloudflareCommandResult> {
  return withConditionalPlatformWorkerCreate(
    accountId,
    workerName,
    (apiBaseUrl) => runPlatformWranglerAtApiBase(operation, accountId, cwd, capture, apiBaseUrl),
    upstreamApiBaseUrl,
  );
}

async function readActivePlatformWorkerVersion(
  configPath: string,
  accountId: string,
  workerName: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<string | null> {
  const result = await runner(
    { type: 'deployments.status', configPath, workerName },
    accountId,
    process.cwd(),
    true,
  );
  if (result.status !== 0) {
    assertCleanPlatformWrangler(result, `read active version for ${workerName}`);
  }
  const value = result.data;
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

export async function readPlatformWorkerDeployments(
  configPath: string,
  accountId: string,
  workerName: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<ReadonlyArray<PlatformWorkerDeployment>> {
  const result = await runner(
    { type: 'deployments.list', configPath, workerName },
    accountId,
    process.cwd(),
    true,
  );
  if (result.status !== 0) {
    assertCleanPlatformWrangler(result, `read deployment lineage for ${workerName}`);
  }
  const value = result.data;
  if (!Array.isArray(value)) {
    throw new Error(`platform: Wrangler returned malformed deployment history for ${workerName}.`);
  }
  return value
    .map((entry, index) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { created_on?: unknown }).created_on !== 'string' ||
        !Array.isArray((entry as { versions?: unknown }).versions)
      ) {
        throw new Error(
          `platform: Wrangler returned malformed deployment history for ${workerName}.`,
        );
      }
      const createdAt = Date.parse((entry as { created_on: string }).created_on);
      if (!Number.isFinite(createdAt)) {
        throw new Error(
          `platform: Wrangler returned malformed deployment history for ${workerName}.`,
        );
      }
      const versions = (entry as { versions: Array<unknown> }).versions.map((version) => {
        if (
          !version ||
          typeof version !== 'object' ||
          typeof (version as { version_id?: unknown }).version_id !== 'string' ||
          !Number.isFinite(Number((version as { percentage?: unknown }).percentage))
        ) {
          throw new Error(
            `platform: Wrangler returned malformed deployment history for ${workerName}.`,
          );
        }
        return {
          percentage: Number((version as { percentage: unknown }).percentage),
          versionId: (version as { version_id: string }).version_id,
        };
      });
      return { createdAt, id: (entry as { id: string }).id, index, versions };
    })
    .sort((left, right) => right.createdAt - left.createdAt || left.index - right.index)
    .map(({ id, versions }) => ({ id, versions }));
}

function samePlatformWorkerTraffic(
  left: PlatformWorkerDeployment | undefined,
  right: PlatformWorkerDeployment,
): boolean {
  if (!left) {
    return false;
  }
  const normalize = (deployment: PlatformWorkerDeployment) =>
    deployment.versions
      .filter((version) => version.percentage > 0)
      .map((version) => `${version.versionId}@${version.percentage}`)
      .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export async function restorePlatformWorkerDeployment(input: {
  accountId: string;
  configPath: string;
  directory: string;
  expectedActiveDeploymentId: string;
  expectedActiveVersionId: string;
  restoration: PlatformWorkerDeployment;
  runner: typeof runPlatformWrangler;
  workerName: string;
}): Promise<void> {
  const restorationVersions = input.restoration.versions.filter(
    (version) => version.percentage > 0,
  );
  const totalPercentage = restorationVersions.reduce(
    (total, version) => total + version.percentage,
    0,
  );
  if (
    restorationVersions.length === 0 ||
    restorationVersions.length > 2 ||
    restorationVersions.some(
      (version, index) =>
        version.percentage > 100 ||
        restorationVersions.findIndex((entry) => entry.versionId === version.versionId) !== index,
    ) ||
    Math.abs(totalPercentage - 100) > 0.001
  ) {
    throw new Error(
      `Worker ${input.workerName} deployment ${input.restoration.id} has an unsupported traffic distribution.`,
    );
  }
  const before = await readPlatformWorkerDeployments(
    input.configPath,
    input.accountId,
    input.workerName,
    input.runner,
  );
  if (
    before[0]?.id !== input.expectedActiveDeploymentId ||
    !deploymentRunsOnlyVersion(before[0], input.expectedActiveVersionId) ||
    before[1]?.id !== input.restoration.id ||
    !samePlatformWorkerTraffic(before[1], input.restoration)
  ) {
    throw new Error(
      `Worker ${input.workerName} changed concurrently before deployment restoration; refusing to overwrite the newer deployment.`,
    );
  }
  const restored = await input.runner(
    {
      type: 'versions.deploy',
      configPath: input.configPath,
      versions: restorationVersions.map((version) => ({
        versionId: version.versionId,
        percentage: version.percentage,
      })),
      message: `Void platform restoration ${input.restoration.id}`,
    },
    input.accountId,
    input.directory,
    true,
  );
  assertCleanPlatformWrangler(restored, `restore deployment ${input.restoration.id}`);
  const after = await readPlatformWorkerDeployments(
    input.configPath,
    input.accountId,
    input.workerName,
    input.runner,
  );
  if (
    !samePlatformWorkerTraffic(after[0], input.restoration) ||
    after[1]?.id !== input.expectedActiveDeploymentId
  ) {
    throw new Error(
      `Worker ${input.workerName} deployment restoration was superseded or did not restore deployment ${input.restoration.id}.`,
    );
  }
}

function deploymentRunsOnlyVersion(
  deployment: PlatformWorkerDeployment | undefined,
  versionId: string | null,
): boolean {
  return (
    versionId !== null &&
    deployment?.versions.length === 1 &&
    deployment.versions[0]?.versionId === versionId &&
    deployment.versions[0].percentage === 100
  );
}

export function classifyPlatformWorkerDeploymentLineage(
  deployments: ReadonlyArray<PlatformWorkerDeployment>,
  installedVersionId: string,
  previousDeploymentId: string | null,
):
  | Readonly<{ deploymentId: string; kind: 'committed' }>
  | Readonly<{ kind: 'concurrent-after' }>
  | Readonly<{ deploymentId: string; kind: 'intervening' }> {
  const installed = deployments[0];
  if (!deploymentRunsOnlyVersion(installed, installedVersionId)) {
    return { kind: 'concurrent-after' };
  }
  return (deployments[1]?.id ?? null) === previousDeploymentId
    ? { deploymentId: installed.id, kind: 'committed' }
    : { deploymentId: installed.id, kind: 'intervening' };
}

export async function inspectNewPlatformWorker(
  client: WorkerInspectionClient,
  accountId: string,
  manifest: PlatformInstallationManifest,
  resourceKey: string,
  workerName: string,
): Promise<'missing' | 'owned'> {
  if (!client.listWorkerNames || !client.getWorkerPlainTextBindings) {
    throw new Error('platform: Cloudflare Worker ownership inspection is unavailable.');
  }
  const workerNames = await client.listWorkerNames(accountId);
  if (!workerNames.includes(workerName)) {
    return 'missing';
  }
  const bindings = await client.getWorkerPlainTextBindings(accountId, workerName);
  let marker;
  try {
    marker = parsePlatformResourceOwnershipMarker(
      JSON.parse(bindings.PLATFORM_OWNERSHIP_MARKER ?? 'null'),
    );
  } catch {
    throw new Error(
      `platform: Worker ${workerName} no longer has this installation's ownership marker; refusing to treat it as installer-owned.`,
    );
  }
  const expected = createPlatformResourceOwnershipMarker({
    accountId,
    installationId: manifest.id,
    ownershipNonce: manifest.ownershipNonce,
    resourceId: workerName,
    resourceKey,
    resourceKind: 'worker',
    resourceName: workerName,
  });
  if (
    marker.accountId !== expected.accountId ||
    marker.installationId !== expected.installationId ||
    marker.ownershipNonce !== expected.ownershipNonce ||
    marker.resourceId !== expected.resourceId ||
    marker.resourceKey !== expected.resourceKey ||
    marker.resourceKind !== expected.resourceKind ||
    marker.resourceName !== expected.resourceName
  ) {
    throw new Error(
      `platform: Worker ${workerName} no longer has this installation's ownership marker; refusing to treat it as installer-owned.`,
    );
  }
  return 'owned';
}

function readPlatformWorkerOwnershipMarker(config: Record<string, unknown>): string {
  const vars = config.vars;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new Error('platform: Platform Worker config is missing its ownership bindings.');
  }
  const marker = (vars as Record<string, unknown>).PLATFORM_OWNERSHIP_MARKER;
  if (typeof marker !== 'string' || marker === '') {
    throw new Error('platform: Platform Worker config is missing its ownership marker.');
  }
  return marker;
}

export async function readActivePlatformWorkerSnapshot(
  configPath: string,
  accountId: string,
  workerName: string,
  expectedOwnershipMarker: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
): Promise<{
  contentHash?: string;
  migrationTag: string | null;
  triggerConfig: CloudflareTriggerConfig;
  versionId: string;
}> {
  const readActiveVersion = () =>
    readActivePlatformWorkerVersion(configPath, accountId, workerName, runner);
  const versionId = await readActiveVersion();
  if (!versionId) {
    throw new Error(
      `platform: Existing Worker ${workerName} has no single active production version.`,
    );
  }
  const snapshot = await readPlatformWorkerVersionSnapshot(
    configPath,
    accountId,
    workerName,
    expectedOwnershipMarker,
    versionId,
    runner,
    async () => {
      if ((await readActiveVersion()) !== versionId) {
        throw new Error(
          `platform: Worker ${workerName} changed concurrently while its active version was inspected.`,
        );
      }
    },
  );
  return snapshot;
}

async function readPlatformWorkerVersionSnapshot(
  configPath: string,
  accountId: string,
  workerName: string,
  expectedOwnershipMarker: string,
  versionId: string,
  runner: typeof runPlatformWrangler,
  validateCurrentVersion?: () => Promise<void>,
): Promise<Awaited<ReturnType<typeof readActivePlatformWorkerSnapshot>>> {
  const result = await runner(
    { type: 'versions.view', versionId, configPath, workerName },
    accountId,
    process.cwd(),
    true,
  );
  assertCleanPlatformWrangler(result, `read rollback metadata for ${workerName}`);
  const value = result.data;
  if (!value || typeof value !== 'object') {
    throw new Error(`platform: Wrangler returned malformed version metadata for ${workerName}.`);
  }
  const resources = (value as { resources?: unknown }).resources;
  const bindings =
    resources && typeof resources === 'object' && !Array.isArray(resources)
      ? (resources as { bindings?: unknown }).bindings
      : null;
  const ownershipBindings = Array.isArray(bindings)
    ? bindings.filter(
        (binding) =>
          binding &&
          typeof binding === 'object' &&
          (binding as { name?: unknown }).name === 'PLATFORM_OWNERSHIP_MARKER' &&
          (binding as { type?: unknown }).type === 'plain_text' &&
          typeof (binding as { text?: unknown }).text === 'string',
      )
    : [];
  if (
    ownershipBindings.length !== 1 ||
    (ownershipBindings[0] as { text: string }).text !== expectedOwnershipMarker
  ) {
    throw new Error(
      `platform: Active Worker version ${versionId} for ${workerName} does not belong to this installation.`,
    );
  }
  await validateCurrentVersion?.();
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
  const migrationTag = readCloudflareVersionMigrationTag(value);
  return {
    ...(metadata.contentHash ? { contentHash: metadata.contentHash } : {}),
    migrationTag,
    triggerConfig: metadata.triggerConfig,
    versionId,
  };
}

export function withoutCompletedPlatformWorkerMigrations(
  config: Record<string, unknown>,
  activeMigrationTag: string | null,
): Record<string, unknown> {
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  const target = migrations.at(-1);
  if (
    activeMigrationTag === null ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    (target as { tag?: unknown }).tag !== activeMigrationTag
  ) {
    return config;
  }
  const result = { ...config };
  delete result.migrations;
  return result;
}

function assertCleanPlatformWrangler(result: CloudflareCommandResult, operation: string): void {
  if (result.status !== 0 || result.signal || result.error) {
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

export function nextTrafficGeneration(manifest: PlatformInstallationManifest): number {
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

export function nextWorkerCutoverGeneration(manifest: PlatformInstallationManifest): number {
  return latestPlatformWorkerCutoverGeneration(manifest) + 1;
}

export function recordWorkerSecretUpdateState(
  manifest: PlatformInstallationManifest,
  generation: number,
  state: 'pending' | 'committed',
  intentId: string,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-secret-updates:${generation}:${state}`,
      resultHash: intentId,
    },
    completedAt,
  );
}

export function recordWorkerCutoverStage(
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

export function recordWorkerCutoverResolution(
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

export function recordWorkerUnsafeTraffic(
  manifest: PlatformInstallationManifest,
  generation: number,
  key: PlatformWorkerKey,
  workerName: string,
  completedAt: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt,
      key: `worker-cutover:${generation}:unsafe-traffic:${key}`,
      resultHash: workerName,
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

function workerCutoverGenerations(manifest: PlatformInstallationManifest) {
  const generations = new Map<
    number,
    {
      resolution: 'committed' | 'restored' | null;
      staged: Map<
        PlatformWorkerKey,
        {
          previousVersionId: string | null;
          previousTriggers: CloudflareTriggerConfig;
          stagedVersionId: string;
          workerName: string;
        }
      >;
      unsafeTraffic: Set<PlatformWorkerKey>;
    }
  >();
  for (const step of manifest.steps) {
    const resolution = /^worker-cutover:(\d+):(committed|restored)$/.exec(step.key);
    if (resolution) {
      const generation = Number(resolution[1]);
      const entry = generations.get(generation) ?? {
        resolution: null,
        staged: new Map(),
        unsafeTraffic: new Set(),
      };
      entry.resolution = resolution[2] as 'committed' | 'restored';
      generations.set(generation, entry);
      continue;
    }
    const unsafeTraffic =
      /^worker-cutover:(\d+):unsafe-traffic:(api|proxy|emailGateway|tail|dispatch)$/.exec(step.key);
    if (unsafeTraffic) {
      const generation = Number(unsafeTraffic[1]);
      const entry = generations.get(generation) ?? {
        resolution: null,
        staged: new Map(),
        unsafeTraffic: new Set(),
      };
      entry.unsafeTraffic.add(unsafeTraffic[2] as PlatformWorkerKey);
      generations.set(generation, entry);
      continue;
    }
    const staged = /^worker-cutover:(\d+):staged:(api|proxy|emailGateway|tail|dispatch)$/.exec(
      step.key,
    );
    if (!staged) {
      continue;
    }
    const generation = Number(staged[1]);
    const snapshot = parseWorkerCutoverSnapshot(step.resultHash);
    if (!snapshot) {
      throw new Error(`platform: Invalid Worker cutover checkpoint ${step.key}.`);
    }
    const entry = generations.get(generation) ?? {
      resolution: null,
      staged: new Map(),
      unsafeTraffic: new Set(),
    };
    entry.staged.set(staged[2] as PlatformWorkerKey, snapshot);
    generations.set(generation, entry);
  }
  return generations;
}

export function interruptedWorkerCutover(
  manifest: PlatformInstallationManifest,
): InterruptedWorkerCutover | null {
  const unresolved = [...workerCutoverGenerations(manifest).entries()]
    .filter(([, entry]) => entry.resolution === null && entry.staged.size > 0)
    .sort(([left], [right]) => right - left)[0];
  return unresolved
    ? {
        generation: unresolved[0],
        staged: unresolved[1].staged,
        unsafeTraffic: unresolved[1].unsafeTraffic,
      }
    : null;
}

export async function verifyPlatformWorkerCutoverVersions(
  manifest: PlatformInstallationManifest,
  generation: number,
  configs: Record<PlatformWorkerKey, Record<string, unknown>>,
  accountId: string,
  runner: typeof runPlatformWrangler = runPlatformWrangler,
  workerKeys: ReadonlyArray<PlatformWorkerKey> = [
    'api',
    'proxy',
    'emailGateway',
    'tail',
    'dispatch',
  ],
): Promise<void> {
  // Shared email setup commits the retained Worker set before its provider
  // mutations. Final verification must still inspect that exact generation.
  const cutover = workerCutoverGenerations(manifest).get(generation);
  if (!cutover || cutover.resolution === 'restored' || cutover.staged.size !== workerKeys.length) {
    throw new Error(
      `platform: Worker cutover generation ${generation} is missing a complete immutable-version checkpoint.`,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-cutover-verify-'));
  try {
    for (const key of workerKeys) {
      const snapshot = cutover.staged.get(key);
      if (!snapshot) {
        throw new Error(
          `platform: Worker cutover generation ${generation} is missing its ${key} checkpoint.`,
        );
      }
      const config = configs[key];
      const configPath = join(directory, `${key}.wrangler.json`);
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      const active = await readActivePlatformWorkerSnapshot(
        configPath,
        accountId,
        snapshot.workerName,
        readPlatformWorkerOwnershipMarker(config),
        runner,
      );
      if (active.versionId !== snapshot.stagedVersionId) {
        throw new Error(
          `platform: Worker ${snapshot.workerName} changed concurrently from staged version ${snapshot.stagedVersionId} to ${active.versionId}; refusing to enable platform traffic.`,
        );
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function recordWorkerTrafficState(
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
  // Older manifests do not have a Worker traffic marker. Only a completed
  // install proves that their endpoints were ever intentionally published.
  // Fresh and interrupted installs begin with desiredState=enabled, so using
  // desired state here would let a resume bypass the initial traffic gate.
  return existing.status === 'installed';
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
