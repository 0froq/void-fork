import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { SUPPORTED_MANIFEST_VERSIONS, type DeployManifest, type DeployEvent } from "../types";
import {
  getProject,
  getUser,
  createDeployment,
  updateDeploymentStatus,
  updateProjectType,
  getDomainsByProjectId,
  countUserDeploymentsToday,
  getActiveDeployment,
  getLastLiveAssetManifest,
  setActiveDeployment,
  markDeploymentRetained,
  setAppliedMigrations,
  getRetainedDeploymentsExcluding,
} from "../db";
import { eq } from "drizzle-orm";
import { deployments } from "../schema";
import { provisionBindings } from "../provisioning/provision";
import { addQueueConsumer } from "../provisioning/cloudflare-api";
import { deleteDispatchScript } from "../cf-api";
import { getPlanLimits, isWithinLimit, STATIC_RETENTION_LIMIT } from "../tiers";
import { SITE_DOMAIN } from "../constants";
import { buildRoutingJson, buildStaticRoutingJson } from "../routing";
import {
  collectAssets,
  createAssetUploadSession,
  uploadAssetBuckets,
  buildAssetMetadata,
  uploadStaticAssets,
  deleteUnreferencedAssets,
} from "../assets";

const DEFAULT_DISPATCH_NAMESPACE = "void-users";
const R2_CONCURRENCY = 6; // Workers allow 6 simultaneous open connections

const app = new Hono<ApiEnv>();

// Deploy to a project
app.post("/:id/deploy", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.get("db"), projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Run independent pre-checks in parallel
  const [activeDeploy, user] = await Promise.all([
    getActiveDeployment(c.get("db"), projectId),
    getUser(c.get("db"), c.get("userId")),
  ]);

  // Reject concurrent deploys to the same project
  if (activeDeploy) {
    // Normalize timestamp to ISO 8601 for safe Date parsing.
    // PostgreSQL returns ISO format; also handles legacy format (space separator, no Z).
    const createdAt = activeDeploy.created_at.includes("T")
      ? activeDeploy.created_at
      : activeDeploy.created_at.replace(" ", "T") + "Z";
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs < 10 * 60 * 1000) {
      return c.json({ error: "deploy in progress", deployment: activeDeploy.id }, 409);
    }
    // Stale — auto-fail and proceed
    await updateDeploymentStatus(c.get("db"), activeDeploy.id, "failed", "timed out");
  }

  // Enforce deploy count limit
  const planLimits = getPlanLimits(user?.plan ?? "free");
  if (planLimits.deploysPerDay > 0) {
    const todayCount = await countUserDeploymentsToday(c.get("db"), c.get("userId"));
    if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
      return c.json({ error: "deploy limit exceeded", limit: planLimits.deploysPerDay }, 429);
    }
  }

  const formData = await c.req.formData();
  const manifestRaw = formData.get("manifest") as string | null;
  const manifest: DeployManifest = manifestRaw
    ? (JSON.parse(manifestRaw) as DeployManifest)
    : { version: 3, bindings: {} };

  // Validate deploy manifest version
  if (manifest.version == null || !SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
    return c.json(
      {
        error: "Unsupported deploy manifest version. Please update void.",
        version: manifest.version ?? null,
        supported: SUPPORTED_MANIFEST_VERSIONS,
      },
      400,
    );
  }

  const source = (formData.get("source") as string | null) ?? null;
  const commit = (formData.get("commit") as string | null) ?? null;

  // Create deployment record
  const deployment = await createDeployment(c.get("db"), projectId, manifestRaw, source, commit);
  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerName = `user-${project.slug}-${deployment.id}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: DeployEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      let currentStep = "start";

      try {
        emit({ event: "start", deploymentId: deployment.id });

        // === ASSET UPLOAD PHASE ===
        currentStep = "asset_upload";
        await updateDeploymentStatus(c.get("db"), deployment.id, "uploading");

        // Collect assets from FormData and compute CF-compatible hashes
        const { manifest: assetManifest, assetsByHash } = await collectAssets(formData);

        // When preflight was used, fill in skipped assets.
        // Prefer the CLI's full manifest (new CLIs send it) to avoid accumulating
        // stale entries from previous deploys. Fall back to the previous deploy's
        // manifest for older CLIs that don't send it.
        const preflightUsed = formData.get("preflight") === "true";
        if (preflightUsed) {
          const fullManifestJson = formData.get("assetManifest") as string | null;
          const fillManifest = fullManifestJson
            ? (JSON.parse(fullManifestJson) as Record<string, { hash: string; size: number }>)
            : await getLastLiveAssetManifest(c.get("db"), projectId);
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
        const hasWorkerFiles = [...formData.keys()].some((k) => k.startsWith("worker:"));
        const isStaticOnly = !hasWorkerFiles;

        // Fetch domains once — used in both static-only and full deploy paths
        const projectDomains = await getDomainsByProjectId(c.get("db"), projectId);

        if (isStaticOnly) {
          // Static-only deploy: upload assets to KV/R2, skip bindings/migrations/WfP
          currentStep = "asset_upload";
          const assetConfig = manifest.assetConfig ?? {
            not_found_handling: "single-page-application",
          };

          // Upload new assets to KV (< 2 MB) or R2 (>= 2 MB)
          const newAssets = Object.keys(assetsByHash).length;
          emit({
            event: "asset_upload",
            total: assetCount,
            new: newAssets,
            cached: assetCount - newAssets,
          });
          const largeHashes = await uploadStaticAssets(
            c.env.STATIC_ASSETS,
            c.env.STATIC_ASSETS_R2,
            assetsByHash,
          );
          emit({ event: "asset_upload_done" });

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
              if (v.startsWith("!")) {
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
            .get("db")
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));

          // Use manifest type when present, fall back to assetConfig-based derivation for older CLIs
          const type =
            manifest.type ??
            (assetConfig.not_found_handling === "single-page-application" ? "spa" : "static");

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

          for (const domain of projectDomains) {
            if (domain.status === "active") {
              await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
            }
          }

          // Mark deployment live + update project type
          await updateDeploymentStatus(c.get("db"), deployment.id, "live");
          await updateProjectType(c.get("db"), projectId, type);
          await setActiveDeployment(c.get("db"), projectId, deployment.id);
          await markDeploymentRetained(c.get("db"), deployment.id, true);

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
            c.get("db"),
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
                  );
                }
                // Delete serving manifest from ROUTING KV
                await c.env.ROUTING.delete(`manifest:${old.id}`);
                await markDeploymentRetained(c.get("db"), old.id, false);
              }
            }
          }

          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          const activeDomains = projectDomains.filter((d) => d.status === "active");
          const url =
            activeDomains.length > 0
              ? `https://${activeDomains[0].hostname}`
              : `https://${project.slug}.${siteDomain}`;

          emit({
            event: "done",
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
        currentStep = "provisioning";

        // Derive binding labels from the manifest upfront so we can show the
        // spinner BEFORE the (potentially slow) CF API provisioning calls.
        const bindingLabels: string[] = [];
        for (const name of manifest.bindings.d1 ?? []) bindingLabels.push(`d1:${name}`);
        for (const name of manifest.bindings.kv ?? []) bindingLabels.push(`kv:${name}`);
        for (const name of manifest.bindings.r2 ?? []) bindingLabels.push(`r2:${name}`);
        for (const q of manifest.queues ?? []) bindingLabels.push(`queue:${q.name}`);
        if (bindingLabels.length > 0) {
          emit({ event: "provisioning", bindings: bindingLabels });
        }

        const workerBindings = await provisionBindings(
          c.get("db"),
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          projectId,
          manifest,
          c.env.JWT_SECRET,
          c.env.VOID_PROXY_SERVICE ?? "void-proxy",
        );

        if (bindingLabels.length > 0) {
          emit({ event: "provisioning_done" });
        }

        // Upload assets via CF asset upload API (3-step flow)
        let completionJwt: string | undefined;
        if (assetCount > 0) {
          const newAssets = Object.keys(assetsByHash).length;
          emit({
            event: "asset_upload",
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

          if (session.buckets.length > 0) {
            completionJwt = await uploadAssetBuckets(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              session.jwt,
              session.buckets,
              assetsByHash,
            );
          } else {
            completionJwt = session.jwt;
          }
          emit({ event: "asset_upload_done" });
        }

        // 1. Upload worker to dispatch namespace via CF API
        currentStep = "worker_upload";
        const workerFormData = new FormData();

        // Collect all worker modules
        const workerFiles: { name: string; content: Blob }[] = [];
        for (const [key, value] of formData.entries()) {
          if (key.startsWith("worker:")) {
            const filePath = key.slice("worker:".length);
            workerFiles.push({ name: filePath, content: value as Blob });
          }
        }

        emit({ event: "worker_upload", modules: workerFiles.length });

        // Build combined bindings: user vars + provisioned (d1/kv/r2) + ASSETS
        // Platform bindings come LAST so they win on name collision (CF uses last-wins semantics)
        const RESERVED_BINDING_NAMES = new Set([
          "__VOID_PROXY",
          "__PROJECT_ID",
          "__VOID_PROXY_TOKEN",
          "ASSETS",
        ]);

        const userVarNames = Object.keys(manifest.vars ?? {});
        const reserved = userVarNames.filter((n) => RESERVED_BINDING_NAMES.has(n));
        if (reserved.length > 0) {
          throw new Error(`reserved binding names: ${reserved.join(", ")}`);
        }

        const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
          type: "plain_text" as const,
          name,
          text,
        }));
        const allBindings = [
          ...plainTextBindings,
          ...workerBindings,
          ...(completionJwt ? [{ name: "ASSETS", type: "assets" }] : []),
        ];

        // Add metadata part (include provisioned bindings + assets)
        if (!manifest.compatibilityDate) {
          console.warn(
            `[deploy] manifest missing compatibilityDate for project ${project.id}, using fallback`,
          );
        }

        const assetConfig = manifest.assetConfig ?? { not_found_handling: "none" };
        const metadata: Record<string, unknown> = {
          main_module: manifest.workerMain ?? "index.js",
          compatibility_date: manifest.compatibilityDate ?? "2026-02-12",
          compatibility_flags: manifest.compatibilityFlags ?? ["nodejs_compat"],
          bindings: allBindings,
          ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
          observability: {
            enabled: true,
            logs: { invocation_logs: true, head_sampling_rate: 1 },
          },
        };
        workerFormData.append(
          "metadata",
          new Blob([JSON.stringify(metadata)], { type: "application/json" }),
        );

        // Add each worker module with correct content type for CF API
        for (const file of workerFiles) {
          const type = moduleContentType(file.name);
          const blob = new Blob([file.content], { type });
          workerFormData.append(file.name, blob, file.name);
        }

        // Upload to CF Workers for Platforms API
        const cfResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` },
            body: workerFormData,
          },
        );

        if (!cfResponse.ok) {
          const error = await cfResponse.text();
          throw new Error(`worker upload failed: ${error}`);
        }

        emit({ event: "worker_upload_done" });

        // 1b. Run migrations via the newly-uploaded worker (v3 flow)
        let migrationsApplied = 0;
        if (manifest.migrations && manifest.migrations.pending > 0) {
          currentStep = "migration";
          await updateDeploymentStatus(c.get("db"), deployment.id, "migrating");
          emit({ event: "migration_start", pending: manifest.migrations.pending });

          try {
            const userWorker = c.env.DISPATCH.get(workerName);
            const proxyTokenBinding = workerBindings.find((b) => b.name === "__VOID_PROXY_TOKEN");
            const migrateResponse = await userWorker.fetch(
              new Request("https://internal/__void/migrate", {
                method: "POST",
                headers: { "x-void-internal": proxyTokenBinding?.text ?? "" },
              }),
            );

            const result = (await migrateResponse.json()) as {
              ok: boolean;
              migrations: {
                name: string;
                applied: boolean;
                durationMs: number;
                error?: string;
              }[];
              error?: string;
            };

            if (!result.ok) {
              throw new Error(`migration failed: ${result.error ?? "unknown error"}`);
            }

            for (const m of result.migrations) {
              if (m.applied) {
                emit({ event: "migration", name: m.name, durationMs: m.durationMs });
                migrationsApplied++;
              }
            }

            const allApplied = result.migrations.map((m) => m.name);
            await setAppliedMigrations(c.get("db"), deployment.id, allApplied);
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
        currentStep = "queue_setup";
        const queueNames = (manifest.queues ?? []).map((q) => q.name);
        if (queueNames.length > 0) {
          emit({ event: "queue_setup", queues: queueNames });
        }

        const dispatchWorkerName = c.env.DISPATCH_WORKER_NAME ?? "void-dispatch";
        await Promise.all(
          (manifest.queues ?? []).map(async (q) => {
            const queueBinding = workerBindings.find(
              (b) => b.type === "queue" && b.name === q.bindingName,
            );
            if (queueBinding?.queue_id) {
              try {
                await addQueueConsumer(
                  c.env.CF_ACCOUNT_ID,
                  c.env.CF_API_TOKEN,
                  queueBinding.queue_id,
                  dispatchWorkerName,
                  {
                    ...(q.maxBatchSize != null && { max_batch_size: q.maxBatchSize }),
                    ...(q.maxBatchTimeout != null && { max_batch_timeout: q.maxBatchTimeout }),
                    ...(q.maxRetries != null && { max_retries: q.maxRetries }),
                    ...(q.retryDelay != null && { retry_delay: q.retryDelay }),
                  },
                );
              } catch (err) {
                // Consumer may already exist — swallow "already exists" / "already has a consumer"
                if (err instanceof Error) {
                  const msg = err.message.toLowerCase();
                  if (!msg.includes("already exists") && !msg.includes("already has a consumer")) {
                    throw err;
                  }
                } else {
                  throw err;
                }
              }
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
        currentStep = "cron_setup";
        const hasCrons = manifest.schedules && manifest.schedules.length > 0;

        if (hasCrons) {
          const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
          await c.env.CRON_SCHEDULER.get(cronId).fetch(
            new Request("https://do/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                workerName,
                schedules: manifest.schedules,
              }),
            }),
          );
        } else {
          // Only clear if previous deploy had crons (avoid creating empty DOs)
          const prevRouting = await c.env.ROUTING.get(project.slug);
          if (prevRouting && JSON.parse(prevRouting).hasCrons) {
            const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
            await c.env.CRON_SCHEDULER.get(cronId).fetch(
              new Request("https://do/clear", { method: "POST" }),
            );
          }
        }

        // 3. Clear previous ISR cache on deploy.
        // Always clear — handles both "new deploy has ISR" and "previous deploy had ISR
        // but new one doesn't" (avoids orphaned KV entries). No-op for empty prefixes.
        await clearIsrCache(c.env.ISR_CACHE, projectId);

        // 3b. Prerender pages (write ISR cache entries before going live)
        currentStep = "prerender";
        if (manifest.prerender && manifest.prerender.length > 0 && manifest.revalidate) {
          emit({ event: "prerender", pages: manifest.prerender.length });
          await updateDeploymentStatus(c.get("db"), deployment.id, "prerendering");
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
          emit({ event: "prerender_done" });
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

        // Update KV routing for active custom domains
        for (const domain of projectDomains) {
          if (domain.status === "active") {
            await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
          }
        }

        // 5. Mark deployment as live + update project mode
        await updateDeploymentStatus(c.get("db"), deployment.id, "live");
        await updateProjectType(
          c.get("db"),
          projectId,
          manifest.type ?? (manifest.framework ? "framework" : "void"),
        );

        // 5b. Set active deployment + mark retained
        await setActiveDeployment(c.get("db"), projectId, deployment.id);
        await markDeploymentRetained(c.get("db"), deployment.id, true);

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
            c.get("db"),
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
            await markDeploymentRetained(c.get("db"), old.id, false);
          }
        }

        // Store asset manifest for future preflight dedup
        if (assetCount > 0) {
          await c
            .get("db")
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));
        }

        const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
        const activeDomains = projectDomains.filter((d) => d.status === "active");
        const fullUrl =
          activeDomains.length > 0
            ? `https://${activeDomains[0].hostname}`
            : `https://${project.slug}.${siteDomain}`;

        emit({
          event: "done",
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
        const msg = err instanceof Error ? err.message : String(err);
        await updateDeploymentStatus(c.get("db"), deployment.id, "failed", msg);
        emit({ event: "error", message: msg, step: currentStep });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
});

// Deploy preflight — returns which assets need uploading based on diff with last deploy
app.post("/:id/deploy/preflight", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.get("db"), projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const body = await c.req.json<{
    assetManifest: Record<string, { hash: string; size: number }>;
  }>();
  const { assetManifest } = body;
  const total = Object.keys(assetManifest).length;

  const prevManifest = await getLastLiveAssetManifest(c.get("db"), projectId);

  if (!prevManifest) {
    return c.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
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
  if (normalized === "/") {
    normalized = "__index__";
  } else {
    normalized = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    if (normalized.endsWith("/")) {
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
  if (typeof revalidate === "number") return revalidate;
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
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
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
  const skip = new Set(["cache-control", "x-isr-cache"]);

  response.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}

function moduleContentType(filename: string): string {
  if (filename.endsWith(".wasm")) return "application/wasm";
  if (filename.endsWith(".map")) return "application/source-map";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".txt")) return "text/plain";
  return "application/javascript+module";
}

export default app;
