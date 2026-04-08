import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  collectAssets,
  createAssetUploadSession,
  uploadAssetBuckets,
  buildAssetMetadata,
  uploadStaticAssets,
  deleteUnreferencedAssets,
} from '../assets';
import { deleteDispatchScript, retryWithBackoff } from '../cf-api';
import { SITE_DOMAIN } from '../constants';
import { DEFAULT_DASHBOARD_URL } from '../constants';
import {
  getProject,
  getDeployment,
  createDeployment,
  updateDeploymentStatus,
  updateProjectType,
  updateProjectWebSocketVersion,
  getDomainsByProjectId,
  countUserDeploymentsToday,
  getActiveDeployment,
  getLastLiveAssetManifest,
  setActiveDeployment,
  markDeploymentRetained,
  setAppliedMigrations,
  getRetainedDeploymentsExcluding,
  getProjectSecrets,
  upsertProjectSecret,
} from '../db';
import { sendDeployFailedEmail } from '../email';
import type { ApiEnv } from '../env';
import {
  BETTER_AUTH_SECRET_NAME,
  decryptProjectSecret,
  generateManagedAuthSecret,
  encryptProjectSecret,
} from '../project-secrets';
import { addQueueConsumer } from '../provisioning/cloudflare-api';
import { provisionBindings } from '../provisioning/provision';
import { buildRoutingJson, buildStaticRoutingJson } from '../routing';
import { deployments } from '../schema';
import { getPlanLimits, isWithinLimit, STATIC_RETENTION_LIMIT } from '../tiers';
import { SUPPORTED_MANIFEST_VERSIONS, type DeployManifest, type DeployEvent } from '../types';
import type { WebSocketMigrationMeta } from '../types';

const DEFAULT_DISPATCH_NAMESPACE = 'void-users';
const R2_CONCURRENCY = 6; // Workers allow 6 simultaneous open connections
/**
 * Detect the known CF WfP bug where APIs return plain text about asset state
 * instead of JSON. CF returns different messages depending on propagation state
 * (e.g. "Assets have already been uploaded", "Assets have not yet been deployed").
 * Valid JSON always starts with `{` or `[`, so `startsWith` avoids false positives.
 */
function isCfAssetPlainText(text: string): boolean {
  return text.trimStart().startsWith('Assets have');
}

const CF_RETRY = { maxRetries: 3, delayMs: 1000 };
const CF_MIGRATION_RETRY = { maxRetries: 5, delayMs: 1000 };

const app = new Hono<ApiEnv>();

function sameClassSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sortUnique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b));
}

function parseManifest(raw: string | null | undefined): DeployManifest | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
}

function sanitizeDeployErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (
    isCfAssetPlainText(trimmed) ||
    // JSON.parse SyntaxError truncates the original text (e.g. `Unexpected token 'A', "Assets hav"...`)
    // so the full substring won't match — detect the truncated form too
    /Unexpected token.*"Assets hav/.test(trimmed)
  ) {
    return 'asset upload returned an unexpected Cloudflare response';
  }
  return message;
}

export function buildWebSocketUploadMigrations(migrations: WebSocketMigrationMeta[] | undefined):
  | {
      new_tag: string;
      steps: Array<{
        new_classes?: string[];
        deleted_classes?: string[];
      }>;
    }
  | undefined {
  if (!migrations || migrations.length === 0) return undefined;

  return {
    new_tag: migrations[migrations.length - 1].tag,
    steps: migrations.map((migration) => ({
      ...(migration.newClasses?.length ? { new_classes: migration.newClasses } : {}),
    })),
  };
}

export function buildWebSocketUploadBindings(
  websocket: DeployManifest['websocket'] | undefined,
): Array<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!websocket) return [];

  const bindings = new Map<string, string>();

  for (const route of websocket.routes) {
    const bindingName = route.bindingName ?? route.className;
    bindings.set(bindingName, route.className);
  }

  const boundClasses = new Set(bindings.values());
  for (const className of sortUnique(websocket.classes)) {
    if (!boundClasses.has(className)) {
      bindings.set(className, className);
    }
  }

  return Array.from(bindings, ([name, class_name]) => ({
    type: 'durable_object_namespace',
    name,
    class_name,
  }));
}

export function enrichWebSocketManifest(
  manifest: DeployManifest,
  previousManifest: DeployManifest | null,
  currentVersion: number,
): { manifest: DeployManifest; changed: boolean; nextVersion: number } {
  const nextClasses = sortUnique(manifest.websocket?.classes);
  const previousClasses = sortUnique(previousManifest?.websocket?.classes);
  const previousMigrations = previousManifest?.websocket?.migrations ?? [];
  const changed = !sameClassSet(nextClasses, previousClasses);

  if (!changed) {
    if (!manifest.websocket && previousMigrations.length === 0) {
      return { manifest, changed: false, nextVersion: currentVersion };
    }
    return {
      manifest: {
        ...manifest,
        websocket: manifest.websocket
          ? {
              ...manifest.websocket,
              classes: nextClasses,
              migrations: previousMigrations,
            }
          : previousManifest?.websocket,
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  // Compute classes that currently exist in Cloudflare by replaying
  // migration history: add from newClasses, remove from deletedClasses.
  // Also include previousClasses as fallback for legacy projects that
  // predate the migration system.
  const existingClasses = new Set(previousClasses);
  for (const m of previousMigrations) {
    for (const name of m.newClasses ?? []) existingClasses.add(name);
    for (const name of m.deletedClasses ?? []) existingClasses.delete(name);
  }
  const newClasses = nextClasses.filter((name) => !existingClasses.has(name));

  // If no new classes to create, no migration step is needed.
  // The class list update is still recorded in the manifest.
  if (newClasses.length === 0) {
    return {
      manifest: {
        ...manifest,
        websocket: {
          routes: manifest.websocket?.routes ?? [],
          classes: nextClasses,
          migrations: previousMigrations,
        },
      },
      changed: true,
      nextVersion: currentVersion,
    };
  }

  const nextVersion = currentVersion + 1;
  const migration: WebSocketMigrationMeta = {
    tag: `ws-v${nextVersion}`,
    newClasses,
  };

  return {
    manifest: {
      ...manifest,
      websocket: {
        routes: manifest.websocket?.routes ?? [],
        classes: nextClasses,
        migrations: [...previousMigrations, migration],
      },
    },
    changed: true,
    nextVersion,
  };
}

// Deploy to a project
app.post('/:id/deploy', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Block deploys for suspended users
  if (c.get('user').suspended_reason) {
    return c.json({ error: 'account suspended: ' + c.get('user').suspended_reason }, 403);
  }

  // Run independent pre-checks in parallel
  const [activeDeploy, currentLiveDeployment] = await Promise.all([
    getActiveDeployment(c.get('db'), projectId),
    project.active_deployment_id
      ? getDeployment(c.get('db'), project.active_deployment_id)
      : Promise.resolve(null),
  ]);
  const user = c.get('user');

  // Reject concurrent deploys to the same project
  if (activeDeploy) {
    // Normalize timestamp to ISO 8601 for safe Date parsing.
    // PostgreSQL returns ISO format; also handles legacy format (space separator, no Z).
    const createdAt = activeDeploy.created_at.includes('T')
      ? activeDeploy.created_at
      : activeDeploy.created_at.replace(' ', 'T') + 'Z';
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs < 10 * 60 * 1000) {
      return c.json({ error: 'deploy in progress', deployment: activeDeploy.id }, 409);
    }
    // Stale — auto-fail and proceed
    await updateDeploymentStatus(c.get('db'), activeDeploy.id, 'failed', 'timed out');
  }

  const formData = await c.req.formData();
  const manifestRaw = formData.get('manifest') as string | null;
  const incomingManifest: DeployManifest = manifestRaw
    ? (JSON.parse(manifestRaw) as DeployManifest)
    : { version: 3, bindings: {} };

  // Validate deploy manifest version
  if (
    incomingManifest.version == null ||
    !SUPPORTED_MANIFEST_VERSIONS.includes(incomingManifest.version)
  ) {
    return c.json(
      {
        error: 'Unsupported deploy manifest version. Please update void.',
        version: incomingManifest.version ?? null,
        supported: SUPPORTED_MANIFEST_VERSIONS,
      },
      400,
    );
  }

  const enrichedManifestResult = enrichWebSocketManifest(
    incomingManifest,
    parseManifest(currentLiveDeployment?.manifest),
    project.websocket_version,
  );
  const manifest = enrichedManifestResult.manifest;
  const finalManifestRaw = JSON.stringify(manifest);

  // Skip deploy if identical to the current live deployment (same manifest + same assets).
  // Secrets are not checked: the secrets API already live-pushes values to the active
  // worker via putWorkerSecret.
  if (currentLiveDeployment && currentLiveDeployment.status === 'live') {
    const sameManifest = currentLiveDeployment.manifest === finalManifestRaw;
    const incomingAssetManifest = formData.get('assetManifest') as string | null;
    const sameAssets =
      incomingAssetManifest != null &&
      currentLiveDeployment.asset_hashes != null &&
      incomingAssetManifest === currentLiveDeployment.asset_hashes;
    if (sameManifest && sameAssets) {
      const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
      const projectDomains = await getDomainsByProjectId(c.get('db'), projectId);
      const activeDomains = projectDomains.filter((d) => d.status === 'active');
      const fullUrl =
        activeDomains.length > 0
          ? `https://${activeDomains[0].hostname}`
          : `https://${project.slug}.${siteDomain}`;

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const emit = (event: DeployEvent) => {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          };
          emit({ event: 'start', deploymentId: currentLiveDeployment.id });
          emit({
            event: 'done',
            deployment: currentLiveDeployment.id,
            url: fullUrl,
            urls: [
              ...activeDomains.map((d) => `https://${d.hostname}`),
              `https://${project.slug}.${siteDomain}`,
            ],
            assets: 0,
            workers: 0,
          });
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }
  }

  // Enforce deploy count limit
  const planLimits = getPlanLimits(user.plan);
  if (planLimits.deploysPerDay > 0) {
    const todayCount = await countUserDeploymentsToday(c.get('db'), c.get('user').id);
    if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
      return c.json({ error: 'deploy limit exceeded', limit: planLimits.deploysPerDay }, 429);
    }
  }

  const source = (formData.get('source') as string | null) ?? null;
  const commit = (formData.get('commit') as string | null) ?? null;

  // Create deployment record
  const deployment = await createDeployment(
    c.get('db'),
    projectId,
    finalManifestRaw,
    source,
    commit,
  );
  if (enrichedManifestResult.changed) {
    await updateProjectWebSocketVersion(c.get('db'), projectId, enrichedManifestResult.nextVersion);
  }
  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerName = `user-${project.slug}-${deployment.id}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: DeployEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };
      let currentStep = 'start';
      let routingSwitched = false;
      let cronSynced = false;

      try {
        emit({ event: 'start', deploymentId: deployment.id });

        // === ASSET UPLOAD PHASE ===
        currentStep = 'asset_upload';
        await updateDeploymentStatus(c.get('db'), deployment.id, 'uploading');

        // Collect assets from FormData and compute CF-compatible hashes
        const { manifest: assetManifest, assetsByHash } = await collectAssets(formData);

        // When preflight was used, fill in skipped assets.
        // Prefer the CLI's full manifest (new CLIs send it) to avoid accumulating
        // stale entries from previous deploys. Fall back to the previous deploy's
        // manifest for older CLIs that don't send it.
        const preflightUsed = formData.get('preflight') === 'true';
        if (preflightUsed) {
          const fullManifestJson = formData.get('assetManifest') as string | null;
          const fillManifest = fullManifestJson
            ? (JSON.parse(fullManifestJson) as Record<string, { hash: string; size: number }>)
            : await getLastLiveAssetManifest(c.get('db'), projectId);
          if (fillManifest) {
            for (const [path, entry] of Object.entries(fillManifest)) {
              if (!(path in assetManifest)) {
                assetManifest[path] = entry;
              }
            }
          }
        }

        const assetCount = Object.keys(assetManifest).length;

        // Determine if this is a static-only deploy (no worker files in FormData)
        const hasWorkerFiles = [...formData.keys()].some((k) => k.startsWith('worker:'));
        const isStaticOnly = !hasWorkerFiles;

        // Fetch domains once — used in both static-only and full deploy paths
        const projectDomains = await getDomainsByProjectId(c.get('db'), projectId);

        if (isStaticOnly) {
          // Static-only deploy: upload assets to KV/R2, skip bindings/migrations/WfP
          currentStep = 'asset_upload';
          const assetConfig = manifest.assetConfig ?? {
            not_found_handling: 'single-page-application',
          };

          // Upload new assets to KV (< 2 MB) or R2 (>= 2 MB)
          const newAssets = assetsByHash.size;
          emit({
            event: 'asset_upload',
            total: assetCount,
            new: newAssets,
            cached: assetCount - newAssets,
          });
          const largeHashes = await uploadStaticAssets(
            c.env.STATIC_ASSETS,
            c.env.STATIC_ASSETS_R2,
            assetsByHash,
            projectId,
          );
          emit({ event: 'asset_upload_done' });

          // Build serving manifest: path → hash (prefix with "!" for R2-stored assets)
          // For assets from preflight (not in assetsByHash), carry forward R2 status
          // from the previous deployment's manifest
          let prevServingManifest: Record<string, string> | null = null;
          if (preflightUsed && project.active_deployment_id) {
            const prev = await c.env.ROUTING.get(`manifest:${project.active_deployment_id}`);
            if (prev) {
              prevServingManifest = JSON.parse(prev) as Record<string, string>;
            }
          }

          // Build a reverse lookup from hash → "!" prefix status from previous manifest
          const prevR2Hashes = new Set<string>();
          if (prevServingManifest) {
            for (const v of Object.values(prevServingManifest)) {
              if (v.startsWith('!')) {
                prevR2Hashes.add(v.slice(1));
              }
            }
          }

          const servingManifest: Record<string, string> = {};
          for (const [path, entry] of Object.entries(assetManifest)) {
            if (largeHashes.has(entry.hash)) {
              // Newly uploaded to R2
              servingManifest[path] = `!${entry.hash}`;
            } else if (prevR2Hashes.has(entry.hash)) {
              // Preflight-skipped asset that was previously in R2
              servingManifest[path] = `!${entry.hash}`;
            } else {
              // KV-stored asset (newly uploaded or preflight-skipped)
              servingManifest[path] = entry.hash;
            }
          }

          // Store serving manifest in ROUTING KV for dispatch to look up
          await c.env.ROUTING.put(`manifest:${deployment.id}`, JSON.stringify(servingManifest));

          // Store asset manifest in DB for future preflight dedup + retention cleanup
          await c
            .get('db')
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));

          // Use manifest type when present, fall back to assetConfig-based derivation for older CLIs
          const type =
            manifest.type ??
            (assetConfig.not_found_handling === 'single-page-application' ? 'spa' : 'static');

          // Set KV routing — uses staticDeploymentId (no WfP worker)
          const existingRouting = await c.env.ROUTING.get(project.slug);
          const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
          const routingJson = buildStaticRoutingJson({
            projectId,
            userId: project.user_id,
            deploymentId: deployment.id,
            assetConfig,
            manifest,
            suspended: existingEntry?.suspended,
          });
          await c.env.ROUTING.put(project.slug, routingJson);
          routingSwitched = true;

          for (const domain of projectDomains) {
            if (domain.status === 'active') {
              await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
            }
          }

          // Mark deployment live + update project type
          await updateDeploymentStatus(c.get('db'), deployment.id, 'live');
          await updateProjectType(c.get('db'), projectId, type);
          await setActiveDeployment(c.get('db'), projectId, deployment.id);
          await markDeploymentRetained(c.get('db'), deployment.id, true);

          // Hard cutoff: delete legacy WfP scripts (one-time cleanup on first KV/R2 deploy)
          const legacyName = `user-${project.slug}`;
          await deleteDispatchScript(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            dispatchNamespace,
            legacyName,
          );

          // Fetch all retained deployments once — used for both WfP cleanup and retention
          const retained = await getRetainedDeploymentsExcluding(
            c.get('db'),
            projectId,
            deployment.id,
          );

          // Delete any previously retained versioned WfP scripts
          for (const old of retained) {
            await deleteDispatchScript(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              dispatchNamespace,
              `user-${project.slug}-${old.id}`,
            );
          }

          // Static retention cleanup — STATIC_RETENTION_LIMIT (100) instead of per-plan limits
          if (STATIC_RETENTION_LIMIT > 0) {
            // STATIC_RETENTION_LIMIT includes the active deployment, so keep (limit - 1) others
            const toEvict = retained.slice(STATIC_RETENTION_LIMIT - 1);
            if (toEvict.length > 0) {
              // Collect all hashes from the current + remaining retained deployments
              const retainedHashes = new Set<string>();
              for (const [, entry] of Object.entries(assetManifest)) {
                retainedHashes.add(entry.hash);
              }
              const keptDeployments = retained.slice(0, STATIC_RETENTION_LIMIT - 1);
              for (const kept of keptDeployments) {
                if (kept.asset_hashes) {
                  const keptManifest = JSON.parse(kept.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  for (const entry of Object.values(keptManifest)) {
                    retainedHashes.add(entry.hash);
                  }
                }
              }

              for (const old of toEvict) {
                // Collect evicted hashes and delete unreferenced assets
                if (old.asset_hashes) {
                  const evictedManifest = JSON.parse(old.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  const evictedHashes = Object.values(evictedManifest).map((e) => e.hash);
                  await deleteUnreferencedAssets(
                    c.env.STATIC_ASSETS,
                    c.env.STATIC_ASSETS_R2,
                    evictedHashes,
                    retainedHashes,
                    projectId,
                  );
                }
                // Delete serving manifest from ROUTING KV
                await c.env.ROUTING.delete(`manifest:${old.id}`);
                await markDeploymentRetained(c.get('db'), old.id, false);
              }
            }
          }

          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          const activeDomains = projectDomains.filter((d) => d.status === 'active');
          const url =
            activeDomains.length > 0
              ? `https://${activeDomains[0].hostname}`
              : `https://${project.slug}.${siteDomain}`;

          emit({
            event: 'done',
            deployment: deployment.id,
            url,
            urls: [
              ...activeDomains.map((d) => `https://${d.hostname}`),
              `https://${project.slug}.${siteDomain}`,
            ],
            assets: assetCount,
            workers: 0,
          });
          return;
        }

        // Full deploy path
        // Provision bindings (D1, KV, R2) — creates CF resources if needed
        currentStep = 'provisioning';

        // Derive binding labels from the manifest upfront so we can show the
        // spinner BEFORE the (potentially slow) CF API provisioning calls.
        const bindingLabels: string[] = [];
        for (const name of manifest.bindings.d1 ?? []) bindingLabels.push(`d1:${name}`);
        for (const name of manifest.bindings.kv ?? []) bindingLabels.push(`kv:${name}`);
        for (const name of manifest.bindings.r2 ?? []) bindingLabels.push(`r2:${name}`);
        for (const q of manifest.queues ?? []) bindingLabels.push(`queue:${q.name}`);
        if (bindingLabels.length > 0) {
          emit({ event: 'provisioning', bindings: bindingLabels });
        }

        const workerBindings = await provisionBindings(
          c.get('db'),
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          projectId,
          manifest,
          c.env.JWT_SECRET,
          c.env.VOID_PROXY_SERVICE ?? 'void-proxy',
        );

        if (bindingLabels.length > 0) {
          emit({ event: 'provisioning_done' });
        }

        if (typeof manifest.vars?.[BETTER_AUTH_SECRET_NAME] === 'string') {
          throw new Error(
            `${BETTER_AUTH_SECRET_NAME} must be configured via project secrets, not manifest.vars`,
          );
        }

        let projectSecretRows = await getProjectSecrets(c.get('db'), projectId);
        if (manifest.auth) {
          const existingAuthSecret = projectSecretRows.find(
            (row) => row.name === BETTER_AUTH_SECRET_NAME,
          );
          if (!existingAuthSecret) {
            const managedSecret = generateManagedAuthSecret();
            const encrypted = await encryptProjectSecret(
              c.env,
              projectId,
              BETTER_AUTH_SECRET_NAME,
              managedSecret,
            );
            await upsertProjectSecret(
              c.get('db'),
              projectId,
              BETTER_AUTH_SECRET_NAME,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.keyVersion,
              'auth-default',
            );
            projectSecretRows = await getProjectSecrets(c.get('db'), projectId);
          }
        }
        const secretBindings = await Promise.all(
          projectSecretRows.map(async (row) => ({
            type: 'secret_text' as const,
            name: row.name,
            text: await decryptProjectSecret(c.env, projectId, row),
          })),
        );

        // Upload assets via CF asset upload API (3-step flow)
        let completionJwt: string | undefined;
        if (assetCount > 0) {
          currentStep = 'asset_upload';
          const newAssets = assetsByHash.size;
          emit({
            event: 'asset_upload',
            total: assetCount,
            new: newAssets,
            cached: assetCount - newAssets,
          });

          const session = await createAssetUploadSession(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            dispatchNamespace,
            workerName,
            assetManifest,
          );
          console.log(
            `[deploy] ${projectId}: asset session created, ${Object.keys(assetManifest).length} manifest entries, ${session.buckets.length} bucket(s), ${assetsByHash.size} blobs available`,
          );

          // Upload asset buckets to CF. When all assets are cached (empty buckets),
          // the session JWT is already the completion token — no exchange needed.
          completionJwt = await uploadAssetBuckets(
            c.env.CF_ACCOUNT_ID,
            session.jwt,
            session.buckets,
            assetsByHash,
          );
          console.log(
            `[deploy] ${projectId}: asset upload complete, got completion JWT: ${completionJwt ? 'yes' : 'no'}`,
          );
          emit({ event: 'asset_upload_done' });
        }

        // 1. Upload worker to dispatch namespace via CF API
        currentStep = 'worker_upload';
        const workerFormData = new FormData();

        // Collect all worker modules
        const workerFiles: { name: string; content: Blob }[] = [];
        for (const [key, value] of formData.entries()) {
          if (key.startsWith('worker:')) {
            const filePath = key.slice('worker:'.length);
            workerFiles.push({ name: filePath, content: value as Blob });
          }
        }

        emit({ event: 'worker_upload', modules: workerFiles.length });

        // Build combined bindings: user vars + provisioned (d1/kv/r2) + ASSETS
        // Platform bindings come LAST so they win on name collision (CF uses last-wins semantics)
        const RESERVED_BINDING_NAMES = new Set([
          '__VOID_PROXY',
          '__PROJECT_ID',
          '__VOID_PROXY_TOKEN',
          'ASSETS',
        ]);

        const userVarNames = Object.keys(manifest.vars ?? {});
        const reserved = userVarNames.filter((n) => RESERVED_BINDING_NAMES.has(n));
        if (reserved.length > 0) {
          throw new Error(`reserved binding names: ${reserved.join(', ')}`);
        }

        const secretNames = new Set(secretBindings.map((s) => s.name));
        const collisions = userVarNames.filter((n) => secretNames.has(n));
        if (collisions.length > 0) {
          console.warn(
            `[deploy] manifest vars collide with project secrets (secrets win): ${collisions.join(', ')}`,
          );
        }

        const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
          type: 'plain_text' as const,
          name,
          text,
        }));
        const websocketBindings = buildWebSocketUploadBindings(manifest.websocket);
        const allBindings = [
          ...plainTextBindings,
          ...secretBindings,
          ...workerBindings,
          ...websocketBindings,
          ...(completionJwt ? [{ name: 'ASSETS', type: 'assets' }] : []),
        ];

        // Add metadata part (include provisioned bindings + assets)
        if (!manifest.compatibilityDate) {
          console.warn(
            `[deploy] manifest missing compatibilityDate for project ${project.id}, using fallback`,
          );
        }

        const assetConfig = manifest.assetConfig ?? { not_found_handling: 'none' };
        const websocketMigrations = buildWebSocketUploadMigrations(manifest.websocket?.migrations);
        const metadata: Record<string, unknown> = {
          main_module: manifest.workerMain ?? 'index.js',
          compatibility_date: manifest.compatibilityDate ?? '2026-02-12',
          compatibility_flags: manifest.compatibilityFlags ?? ['nodejs_compat'],
          bindings: allBindings,
          ...(websocketMigrations ? { migrations: websocketMigrations } : {}),
          ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
          observability: {
            enabled: true,
            logs: { invocation_logs: true, head_sampling_rate: 1 },
          },
        };
        workerFormData.append(
          'metadata',
          new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
        );

        // Add each worker module with correct content type for CF API
        for (const file of workerFiles) {
          const type = moduleContentType(file.name);
          const blob = new Blob([file.content], { type });
          workerFormData.append(file.name, blob, file.name);
        }

        // Upload to CF Workers for Platforms API.
        // CF's WfP API sometimes returns plain text (e.g. "Assets have already
        // been uploaded") with 200 status instead of completing the upload.
        // This is the same CF bug handled in createAssetUploadSession — retry
        // to hit a different edge node.
        const workerUploadUrl = `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`;
        await retryWithBackoff(
          async () => {
            const cfResponse = await fetch(workerUploadUrl, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` },
              body: workerFormData,
            });

            if (!cfResponse.ok) {
              const error = await cfResponse.text();
              console.error(
                `[deploy] ${projectId}: worker upload failed (${cfResponse.status}): ${error.slice(0, 500)}`,
              );
              throw new Error(`worker upload failed: ${error}`);
            }

            const cfBody = await cfResponse.text();
            if (isCfAssetPlainText(cfBody)) {
              console.warn(
                `[deploy] ${projectId}: worker upload got CF plain-text response, retrying: ${cfBody.slice(0, 100)}`,
              );
              return undefined; // retry
            }
            return true;
          },
          { ...CF_RETRY, errorMessage: 'worker upload returned an unexpected Cloudflare response' },
        );

        emit({ event: 'worker_upload_done' });

        // 1b. Run migrations via the newly-uploaded worker (v3 flow)
        let migrationsApplied = 0;
        if (manifest.migrations && manifest.migrations.pending > 0) {
          currentStep = 'migration';
          await updateDeploymentStatus(c.get('db'), deployment.id, 'migrating');
          emit({ event: 'migration_start', pending: manifest.migrations.pending });

          try {
            const proxyTokenBinding = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN');

            // CF's WfP dispatch can return the same "Assets have already been
            // uploaded" plain text on the first invocation after a worker upload
            // (asset state propagation lag). Retry with backoff, same as the
            // worker upload step.
            type MigrationResult = {
              ok: boolean;
              migrations: {
                name: string;
                applied: boolean;
                durationMs: number;
                error?: string;
              }[];
              error?: string;
            };
            const result = await retryWithBackoff<MigrationResult>(
              async () => {
                const userWorker = c.env.DISPATCH.get(workerName);
                const migrateResponse = await userWorker.fetch(
                  new Request('https://internal/__void/migrate', {
                    method: 'POST',
                    headers: { 'x-void-internal': proxyTokenBinding?.text ?? '' },
                    signal: AbortSignal.timeout(300_000),
                  }),
                );

                const text = await migrateResponse.text();
                if (isCfAssetPlainText(text)) {
                  console.warn(`[deploy] migration dispatch returned CF plain text: ${text}`);
                  return undefined; // retry
                }

                try {
                  return JSON.parse(text) as MigrationResult;
                } catch {
                  if (migrateResponse.ok) {
                    // 2xx but non-JSON — likely CF propagation lag, retry.
                    console.warn(
                      `[deploy] migration returned non-JSON 2xx, retrying: ${text.slice(0, 500)}`,
                    );
                    return undefined; // retry
                  }
                  throw new Error(
                    `migration failed (${migrateResponse.status}): ${text.slice(0, 200)}`,
                  );
                }
              },
              {
                ...CF_MIGRATION_RETRY,
                errorMessage:
                  'migration dispatch failed: CF returned plain-text asset response after retries',
              },
            );

            if (!result.ok) {
              throw new Error(`migration failed: ${result.error ?? 'unknown error'}`);
            }

            for (const m of result.migrations) {
              if (m.applied) {
                emit({ event: 'migration', name: m.name, durationMs: m.durationMs });
                migrationsApplied++;
              }
            }

            const allApplied = result.migrations.map((m) => m.name);
            await setAppliedMigrations(c.get('db'), deployment.id, allApplied);
          } catch (err) {
            // Migration failed — delete the new worker, abort
            await deleteDispatchScript(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              dispatchNamespace,
              workerName,
            );
            throw err;
          }
        }

        // 2b. Configure queue consumers (dispatch worker relays to user workers)
        currentStep = 'queue_setup';
        const queueNames = (manifest.queues ?? []).map((q) => q.name);
        if (queueNames.length > 0) {
          emit({ event: 'queue_setup', queues: queueNames });
        }

        const dispatchWorkerName = c.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
        await Promise.all(
          (manifest.queues ?? []).map(async (q) => {
            const queueBinding = workerBindings.find(
              (b) => b.type === 'queue' && b.name === q.bindingName,
            );
            if (queueBinding?.queue_id) {
              await addQueueConsumer(
                c.env.CF_ACCOUNT_ID,
                c.env.CF_API_TOKEN,
                queueBinding.queue_id,
                dispatchWorkerName,
                {
                  ...(q.maxBatchSize != null && { batch_size: q.maxBatchSize }),
                  ...(q.maxBatchTimeout != null && { max_wait_time_ms: q.maxBatchTimeout * 1000 }),
                  ...(q.maxRetries != null && { max_retries: q.maxRetries }),
                  ...(q.retryDelay != null && { retry_delay: q.retryDelay }),
                },
              );
              // Store queue→worker mapping for relay routing
              await c.env.ROUTING.put(
                `queue:${queueBinding.queue_name}`,
                JSON.stringify({
                  workerName,
                  projectId,
                  queueName: q.name,
                }),
              );
            }
          }),
        );

        // 2c. Sync cron schedules to CronScheduler DO
        currentStep = 'cron_setup';
        const hasCrons = manifest.schedules && manifest.schedules.length > 0;

        if (hasCrons) {
          const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
          const cronProxyToken = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text;
          await c.env.CRON_SCHEDULER.get(cronId).fetch(
            new Request('https://do/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                workerName,
                schedules: manifest.schedules,
                proxyToken: cronProxyToken,
              }),
            }),
          );
          cronSynced = true;
        } else {
          // Only clear if previous deploy had crons (avoid creating empty DOs)
          const prevRouting = await c.env.ROUTING.get(project.slug);
          if (prevRouting && JSON.parse(prevRouting).hasCrons) {
            const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
            await c.env.CRON_SCHEDULER.get(cronId).fetch(
              new Request('https://do/clear', { method: 'POST' }),
            );
          }
        }

        // 3. Clear previous ISR cache on deploy.
        // Always clear — handles both "new deploy has ISR" and "previous deploy had ISR
        // but new one doesn't" (avoids orphaned KV entries). No-op for empty prefixes.
        await clearIsrCache(c.env.ISR_CACHE, projectId);

        // 3b. Prerender pages (write ISR cache entries before going live)
        currentStep = 'prerender';
        if (manifest.prerender && manifest.prerender.length > 0 && manifest.revalidate) {
          emit({ event: 'prerender', pages: manifest.prerender.length });
          await updateDeploymentStatus(c.get('db'), deployment.id, 'prerendering');
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;

          await uploadPool(manifest.prerender, 3, async (pathname) => {
            const ttl = resolvePathTtl(manifest.revalidate, pathname);
            if (ttl <= 0) return;

            try {
              // Invoke the user worker directly via dispatch namespace
              const userWorker = c.env.DISPATCH.get(workerName);
              const url = `https://${project.slug}.${siteDomain}${pathname}`;
              const response = await userWorker.fetch(new Request(url));

              if (response.ok) {
                const key = isrCacheKey(projectId, pathname);
                const headers = serializePrerenderHeaders(response);
                const body = await response.arrayBuffer();
                const packed = packIsrValue(headers, body);

                await c.env.ISR_CACHE.put(key, packed, {
                  metadata: {
                    s: response.status,
                    c: Date.now(),
                    t: ttl,
                  },
                });
              }
            } catch {
              // Prerender failures are non-blocking — page will be rendered on first request
            }
          });
          emit({ event: 'prerender_done' });
        }

        // 4. Update KV routing table
        // Carry forward suspended flag from current KV entry
        const existingRouting = await c.env.ROUTING.get(project.slug);
        const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
        // Include per-request limits for dispatch enforcement
        const dispatchLimits =
          planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
            ? {
                ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
                ...(planLimits.subRequestsPerInvocation > 0
                  ? { subRequests: planLimits.subRequestsPerInvocation }
                  : {}),
              }
            : null;
        const routingJson = buildRoutingJson({
          workerName,
          projectId,
          userId: project.user_id,
          manifest,
          deploymentId: deployment.id,
          dispatchLimits,
          suspended: existingEntry?.suspended,
          hasCrons,
        });
        await c.env.ROUTING.put(project.slug, routingJson);

        // Traffic can now reach the new worker via project.slug.
        // Set the flag immediately so the outer catch never deletes a live worker.
        routingSwitched = true;

        // Update KV routing for active custom domains
        for (const domain of projectDomains) {
          if (domain.status === 'active') {
            await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
          }
        }

        // 5. Mark deployment as live + update project mode
        await updateDeploymentStatus(c.get('db'), deployment.id, 'live');
        await updateProjectType(
          c.get('db'),
          projectId,
          manifest.type ?? (manifest.framework ? 'framework' : 'void'),
        );

        // 5b. Set active deployment + mark retained
        await setActiveDeployment(c.get('db'), projectId, deployment.id);
        await markDeploymentRetained(c.get('db'), deployment.id, true);

        // Legacy cleanup — delete unversioned worker script (safe no-op if already gone)
        const legacyWorkerName = `user-${project.slug}`;
        await deleteDispatchScript(
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          dispatchNamespace,
          legacyWorkerName,
        );

        // Retention cleanup — delete old worker scripts beyond plan limit
        const retentionLimit = planLimits.retainedDeployments;
        if (retentionLimit > 0) {
          const retained = await getRetainedDeploymentsExcluding(
            c.get('db'),
            projectId,
            deployment.id,
          );
          // retentionLimit includes the active deployment, so keep (limit - 1) others
          const toEvict = retained.slice(retentionLimit - 1);
          for (const old of toEvict) {
            const oldWorkerName = `user-${project.slug}-${old.id}`;
            await deleteDispatchScript(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              dispatchNamespace,
              oldWorkerName,
            );
            await markDeploymentRetained(c.get('db'), old.id, false);
          }
        }

        // Store asset manifest for future preflight dedup
        if (assetCount > 0) {
          await c
            .get('db')
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));
        }

        const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
        const activeDomains = projectDomains.filter((d) => d.status === 'active');
        const fullUrl =
          activeDomains.length > 0
            ? `https://${activeDomains[0].hostname}`
            : `https://${project.slug}.${siteDomain}`;

        emit({
          event: 'done',
          deployment: deployment.id,
          url: fullUrl,
          urls: [
            ...activeDomains.map((d) => `https://${d.hostname}`),
            `https://${project.slug}.${siteDomain}`,
          ],
          assets: assetCount,
          workers: workerFiles.length,
          ...(migrationsApplied > 0 && { migrations: migrationsApplied }),
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = sanitizeDeployErrorMessage(raw);
        if (msg !== raw) {
          console.error(`[deploy] raw error before sanitization for ${workerName}: ${raw}`);
        }

        if (routingSwitched) {
          // Routing already points to this worker — it IS serving live traffic.
          // Mark as "live" so DB state matches reality. The late-step failure
          // (retention cleanup, asset_hashes update, etc.) is non-critical and
          // will self-correct on the next deploy.
          console.error(`[deploy] post-routing step failed for ${workerName}: ${msg}`);
          await updateDeploymentStatus(c.get('db'), deployment.id, 'live').catch(() => {});
          await updateProjectType(
            c.get('db'),
            projectId,
            manifest.type ?? (manifest.framework ? 'framework' : 'void'),
          ).catch(() => {});
          await setActiveDeployment(c.get('db'), projectId, deployment.id).catch(() => {});
          await markDeploymentRetained(c.get('db'), deployment.id, true).catch(() => {});
          // Emit "done" so the CLI shows success with the URL — the deploy IS live.
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          const slugUrl = `https://${project.slug}.${siteDomain}`;
          emit({
            event: 'done',
            deployment: deployment.id,
            url: slugUrl,
            urls: [slugUrl],
            assets: 0,
            workers: 0,
          });
        } else {
          // Routing not yet switched — safe to clean up the worker script and
          // mark the deployment as failed.
          await deleteDispatchScript(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            dispatchNamespace,
            workerName,
          ).catch((e) =>
            console.error(`[deploy] failed to clean up worker script ${workerName}:`, e),
          );
          // Clear cron DO if we synced it before the failure (step 2c runs before routing switch)
          if (cronSynced) {
            const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
            await c.env.CRON_SCHEDULER.get(cronId)
              .fetch(new Request('https://do/clear', { method: 'POST' }))
              .catch((e) =>
                console.error(`[deploy] failed to clear cron scheduler for ${projectId}:`, e),
              );
          }
          await updateDeploymentStatus(c.get('db'), deployment.id, 'failed', msg);
          emit({ event: 'error', message: msg, step: currentStep });
          if (c.env.EMAIL && user.email) {
            const dashboardUrl = c.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
            c.executionCtx.waitUntil(
              sendDeployFailedEmail(c.env.EMAIL, user.email, project.slug, msg, dashboardUrl).catch(
                (err) => console.error(`[deploy-failed-email] Failed for ${project.slug}:`, err),
              ),
            );
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
});

// Deploy preflight — returns which assets need uploading based on diff with last deploy
app.post('/:id/deploy/preflight', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json<{
    assetManifest: Record<string, { hash: string; size: number }>;
    hasWorker?: boolean;
  }>();
  const { assetManifest, hasWorker } = body;
  const total = Object.keys(assetManifest).length;

  const prevManifest = await getLastLiveAssetManifest(c.get('db'), projectId);

  if (!prevManifest) {
    return c.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
  }

  // Detect storage mechanism changes between previous and current deploy.
  // Static deploys store assets in KV/R2 (serving manifest in ROUTING KV).
  // WfP deploys store assets via CF's asset upload API (ASSETS binding).
  // Dedup is only safe when both deploys use the same storage mechanism.
  if (project.active_deployment_id) {
    const hasServingManifest = await c.env.ROUTING.get(`manifest:${project.active_deployment_id}`);
    if (!hasServingManifest) {
      // Previous was WfP — assets are in CF's store, not KV/R2.
      // All assets must be uploaded fresh.
      return c.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
    }
    if (hasWorker) {
      // Previous was static (KV/R2) but current is WfP — different storage.
      // Assets must be re-uploaded to CF's asset API.
      return c.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
    }
  }

  const needed: string[] = [];
  for (const [path, entry] of Object.entries(assetManifest)) {
    const prev = prevManifest[path];
    if (!prev || prev.hash !== entry.hash) {
      needed.push(path);
    }
  }

  return c.json({ needed, total, skipped: total - needed.length });
});

async function uploadPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

async function clearIsrCache(kv: KVNamespace, projectId: string): Promise<void> {
  const prefix = `${projectId}/isr/`;
  let cursor: string | undefined;

  do {
    const listed = await kv.list({ prefix, cursor });
    if (listed.keys.length > 0) {
      await uploadPool(listed.keys, R2_CONCURRENCY, (key) => kv.delete(key.name));
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

// --- ISR prerender helpers (inlined from dispatch to avoid cross-package dependency) ---

/**
 * Pack response headers + body into a single ArrayBuffer.
 * Format: [4 bytes uint32 LE header length][UTF-8 header JSON][raw body]
 */
function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/**
 * Build the cache key for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
function isrCacheKey(projectId: string, pathname: string): string {
  let normalized = pathname;
  if (normalized === '/') {
    normalized = '__index__';
  } else {
    normalized = normalized.startsWith('/') ? normalized.slice(1) : normalized;
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
  }
  return `${projectId}/isr/${normalized}`;
}

/**
 * Resolve the ISR TTL for a given pathname.
 * For object form, first matching pattern wins.
 */
function resolvePathTtl(
  revalidate: number | Record<string, number> | undefined,
  pathname: string,
): number {
  if (revalidate == null) return 0;
  if (typeof revalidate === 'number') return revalidate;
  for (const [pattern, ttl] of Object.entries(revalidate)) {
    if (matchPattern(pattern, pathname)) return ttl;
  }
  return 0;
}

const MAX_CACHE = 256;
const regexCache = new Map<string, RegExp>();

/**
 * Match a pattern against a pathname.
 * `*` matches any characters including `/`.
 */
function matchPattern(pattern: string, pathname: string): boolean {
  let regex = regexCache.get(pattern);
  if (regex) {
    regexCache.delete(pattern);
    regexCache.set(pattern, regex);
  } else {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    regex = new RegExp(`^${escaped}$`);
    if (regexCache.size >= MAX_CACHE) {
      regexCache.delete(regexCache.keys().next().value!);
    }
    regexCache.set(pattern, regex);
  }
  return regex.test(pathname);
}

/**
 * Extract response headers as a plain object, skipping ISR-managed headers.
 */
function serializePrerenderHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  const skip = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

  response.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}

function moduleContentType(filename: string): string {
  if (filename.endsWith('.wasm')) return 'application/wasm';
  if (filename.endsWith('.map')) return 'application/source-map';
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.txt')) return 'text/plain';
  return 'application/javascript+module';
}

export default app;
