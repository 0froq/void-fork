import {
  createPlatformWorkerConfigs,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  type PlatformInstallationManifest,
} from '@void/platform';
import {
  requireId,
  recordResource,
  recordProvisionIntent,
  inventoryUnmanagedPlatformWorkerTraffic,
  mergePlatformWorkerTrafficConfig,
  publishPlatformWorkerCustomDomains,
} from './platform-installer-resources.ts';
import { platformWorkerSecretPayload } from './platform-installer-secrets.ts';
import {
  type PlatformInstallerDependencies,
  type PlatformWorkerRollback,
  type PlatformInstallationSecrets,
  type PlatformWorkerKey,
  type PlatformWorkerSecretUpdateIntent,
  type InstallerClient,
} from './platform-installer-types.ts';
import {
  runPlatformWrangler,
  deployPlatformWorker,
  recordWorkerCutoverStage,
  recordWorkerUnsafeTraffic,
  inspectNewPlatformWorker,
} from './platform-installer-workers.ts';
import { type PlatformInstallPlan, type PlatformInstallPlanAction } from './platform-plan.ts';
import { writeInstallationManifest } from './platform-registry.ts';
import {
  platformManagedWorkerTraffic,
  recordPlatformWorkerTraffic,
  trackedPlatformWorkerTraffic,
} from './platform-traffic.ts';

export async function uploadInstallationWorkers(input: {
  readonly dependencies: PlatformInstallerDependencies;
  readonly requiresStagedCommit: boolean;
  readonly workerSecretUpdateIntent: PlatformWorkerSecretUpdateIntent | null;
  readonly recoveringUnsafeTraffic: boolean;
  readonly workerActions: ReadonlyArray<PlatformInstallPlanAction>;
  readonly workerKeys: ReadonlyArray<PlatformWorkerKey>;
  readonly workerDeploymentSecrets: PlatformInstallationSecrets;
  readonly plan: PlatformInstallPlan;
  readonly zoneId: string;
  manifest: PlatformInstallationManifest;
  readonly now: () => string;
  readonly writeRemoteInstallationCheckpoint: (
    client: InstallerClient,
    checkpointPlan: PlatformInstallPlan,
    checkpointManifest: PlatformInstallationManifest,
  ) => Promise<void>;
  readonly configs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly previousConfigs: ReturnType<typeof createPlatformWorkerConfigs>;
  readonly cloudflareApiBaseUrl: string;
  readonly workerCutoverGeneration: number;
  readonly preserveDisabled: boolean;
  readonly managedRoutes: ReturnType<typeof platformManagedWorkerTraffic>['routes'];
  readonly previousPublicEndpoints: boolean;
  readonly ids: { [k: string]: string };
  readonly runParallelPinnedPlatformWrangler: typeof runPlatformWrangler;
  readonly runPinnedPlatformWrangler: typeof runPlatformWrangler;
  readonly workerRollbacks: Array<PlatformWorkerRollback>;
}): Promise<void> {
  const {
    dependencies,
    requiresStagedCommit,
    workerSecretUpdateIntent,
    recoveringUnsafeTraffic,
    workerActions,
    workerKeys,
    workerDeploymentSecrets,
    plan,
    zoneId,
    now,
    writeRemoteInstallationCheckpoint,
    configs,
    previousConfigs,
    cloudflareApiBaseUrl,
    workerCutoverGeneration,
    preserveDisabled,
    managedRoutes,
    previousPublicEndpoints,
    ids,
    runParallelPinnedPlatformWrangler,
    runPinnedPlatformWrangler,
    workerRollbacks,
  } = input;

  const parallelWorkerUploads =
    !dependencies.deployWorker &&
    !requiresStagedCommit &&
    !workerSecretUpdateIntent &&
    !recoveringUnsafeTraffic &&
    workerActions.length === workerKeys.length &&
    workerActions.every((action) => action.action === 'update');
  let workerManifestQueue = Promise.resolve();
  let workerManifestFailed = false;
  let workerManifestFailure: unknown;
  const checkpointWorkerManifest = (
    update: () => Promise<void>,
    safetyRecovery = false,
  ): Promise<void> => {
    if (!parallelWorkerUploads) {
      return update();
    }
    const result = workerManifestQueue.then(async () => {
      if (workerManifestFailed && !safetyRecovery) {
        throw workerManifestFailure;
      }
      try {
        await update();
      } catch (error) {
        workerManifestFailed = true;
        workerManifestFailure = error;
        throw error;
      }
    });
    workerManifestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let availableUploadSlots = 2;
  let uploadFailure: unknown;
  const uploadWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const acquireUploadSlot = async (): Promise<(failure?: unknown) => void> => {
    if (uploadFailure !== undefined) {
      throw uploadFailure;
    }
    if (availableUploadSlots === 0) {
      await new Promise<void>((resolve, reject) => uploadWaiters.push({ resolve, reject }));
    } else {
      availableUploadSlots--;
    }
    return (failure) => {
      if (failure !== undefined && uploadFailure === undefined) {
        uploadFailure = failure;
        for (const waiter of uploadWaiters.splice(0)) {
          waiter.reject(failure);
        }
      }
      const next = uploadFailure === undefined ? uploadWaiters.shift() : undefined;
      if (next) {
        next.resolve();
      } else {
        availableUploadSlots++;
      }
    };
  };
  const workerReady = (parallelWorkerUploads ? workerKeys : []).map(() => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  });
  const uploadBatch = Promise.all(workerReady.map((ready) => ready.promise)).then(
    () => ({ error: null }),
    (error: unknown) => ({ error }),
  );
  const deployOneWorker = async (
    key: PlatformWorkerKey,
    waitForPriorWorker?: () => Promise<void>,
    onReadyForActivation?: () => Promise<void>,
  ): Promise<void> => {
    dependencies.onProgress?.(`Deploying the ${key} service`);
    let workerStepStarted = performance.now();
    const markWorkerStep = (step: string) => {
      if (process.env.VOID_PLATFORM_TIMINGS === '1') {
        process.stderr.write(
          `[platform timing] worker ${key} ${step} ${(performance.now() - workerStepStarted).toFixed(0)} ms\n`,
        );
      }
      workerStepStarted = performance.now();
    };
    const action = workerActions.find(
      (entry) => entry.key === (key === 'emailGateway' ? 'email-gateway-worker' : `${key}-worker`),
    )!;
    const workerSecrets = platformWorkerSecretPayload(
      key,
      workerDeploymentSecrets,
      plan.account.id,
      zoneId,
      action.action !== 'create',
    );
    await checkpointWorkerManifest(async () => {
      const intended = recordProvisionIntent(input.manifest!, action, now());
      if (intended !== input.manifest) {
        input.manifest = intended;
        writeInstallationManifest(input.manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
      }
    });
    await dependencies.revalidateBeforeWorkerDeploy(input.manifest!, action);
    markWorkerStep('revalidate');
    const preservedRoutes = dependencies.deployWorker
      ? []
      : action.action === 'create'
        ? []
        : await inventoryUnmanagedPlatformWorkerTraffic(dependencies.client, plan, action.name);
    markWorkerStep('traffic inventory');
    const workerConfig = mergePlatformWorkerTrafficConfig(configs[key], preservedRoutes);
    const previousWorkerConfig = mergePlatformWorkerTrafficConfig(
      previousConfigs[key],
      preservedRoutes,
    );
    const rollback = dependencies.deployWorker
      ? await dependencies.deployWorker(workerConfig, workerSecrets, previousWorkerConfig)
      : await deployPlatformWorker(workerConfig, workerSecrets, {
          apiBaseUrl: cloudflareApiBaseUrl,
          operatorApiToken: dependencies.operatorApiToken,
          ...(parallelWorkerUploads
            ? { acquireUploadSlot, onReadyForActivation, waitForPriorWorker }
            : {}),
          ...(dependencies.client.request
            ? { readCloudflare: (path) => dependencies.client.request!(path) }
            : {}),
          onStaged: async (previousVersionId, stagedVersionId, previousTriggers) => {
            await checkpointWorkerManifest(async () => {
              input.manifest = recordWorkerCutoverStage(
                input.manifest!,
                workerCutoverGeneration,
                key,
                previousVersionId,
                stagedVersionId,
                action.name,
                previousTriggers,
                now(),
              );
              writeInstallationManifest(input.manifest);
              await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
            });
          },
          onTrafficPublished: async () => {
            if (!dependencies.client.listWorkerDomains || !dependencies.client.listWorkerRoutes) {
              throw new Error('platform: Cloudflare traffic inventory is unavailable.');
            }
            const [customDomains, routes] = await Promise.all([
              dependencies.client.listWorkerDomains(plan.account.id),
              zoneId ? dependencies.client.listWorkerRoutes(zoneId) : Promise.resolve([]),
            ]);
            await checkpointWorkerManifest(async () => {
              const next = recordPlatformWorkerTraffic(
                input.manifest!,
                action.name,
                { customDomains, routes },
                now(),
              );
              if (JSON.stringify(next.resources) !== JSON.stringify(input.manifest!.resources)) {
                input.manifest = next;
                writeInstallationManifest(input.manifest);
                await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
              }
            });
          },
          onUnsafeTraffic: async () => {
            await checkpointWorkerManifest(async () => {
              input.manifest = recordWorkerUnsafeTraffic(
                input.manifest!,
                workerCutoverGeneration,
                key,
                action.name,
                now(),
              );
              writeInstallationManifest(input.manifest);
              await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
            }, true);
          },
          managedRoutes: preserveDisabled
            ? []
            : managedRoutes
                .filter((route) => route.script === action.name)
                .map((route) => route.pattern),
          preservedRoutes,
          publishCustomDomains: (workerName, origins) =>
            publishPlatformWorkerCustomDomains(
              dependencies.client,
              plan.account.id,
              workerName,
              origins,
            ),
          publishRoutes: async (workerName, patterns) => {
            if (!dependencies.client.publishWorkerRoutesSafely) {
              throw new Error('platform: Safe Cloudflare Worker route publication is unavailable.');
            }
            if (zoneId) {
              await dependencies.client.publishWorkerRoutesSafely(zoneId, workerName, patterns);
            } else if (patterns.length > 0) {
              throw new Error('platform: Cannot publish zone routes in workers.dev mode.');
            }
          },
          previousConfig: previousWorkerConfig,
          previousPublicEndpoints: previousPublicEndpoints,
          inspectNewWorker: () =>
            inspectNewPlatformWorker(
              dependencies.client,
              plan.account.id,
              input.manifest!,
              action.key,
              action.name,
            ),
          removeCustomDomains: async () => {
            if (!dependencies.client.removeRoutes) {
              throw new Error('platform: Cloudflare route removal is unavailable.');
            }
            await dependencies.client.removeRoutes(
              plan.account.id,
              zoneId,
              trackedPlatformWorkerTraffic(input.manifest!, new Set([action.name])),
            );
          },
          retainNewWorker: async () => {
            await dependencies.client.putKvValue(
              plan.account.id,
              requireId(ids, 'routing-kv'),
              PLATFORM_DISABLED_KEY,
              PLATFORM_DISABLED_VALUE,
            );
          },
          runner: parallelWorkerUploads
            ? runParallelPinnedPlatformWrangler
            : runPinnedPlatformWrangler,
          workerExisted: action.action !== 'create',
        });
    markWorkerStep('deploy');
    if (rollback) {
      workerRollbacks.push(rollback);
    }
    await checkpointWorkerManifest(async () => {
      const recorded = recordResource(input.manifest!, action, action.name, 'created', now());
      if (
        rollback ||
        dependencies.deployWorker ||
        JSON.stringify(recorded.resources) !== JSON.stringify(input.manifest!.resources)
      ) {
        input.manifest = recorded;
        writeInstallationManifest(input.manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, input.manifest);
      }
    });
    markWorkerStep('record');
  };
  if (parallelWorkerUploads) {
    const tasks: Array<Promise<void>> = [];
    for (const [index, key] of workerKeys.entries()) {
      const priorWorker = tasks.at(-1);
      const ready = workerReady[index]!;
      const task = deployOneWorker(key, priorWorker ? () => priorWorker : undefined, async () => {
        ready.resolve();
        const batch = await uploadBatch;
        if (batch.error !== null) {
          throw batch.error;
        }
      });
      task.then(
        () => ready.resolve(),
        (error: unknown) => ready.reject(error),
      );
      tasks.push(task);
    }
    const results = await Promise.allSettled(tasks);
    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstFailure) {
      throw firstFailure.reason;
    }
  } else {
    for (const key of workerKeys) {
      await deployOneWorker(key);
    }
  }
}
