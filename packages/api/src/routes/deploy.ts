import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { SUPPORTED_MANIFEST_VERSIONS, type DeployManifest } from "../types";
import {
  getProject,
  getUser,
  createDeployment,
  updateDeploymentStatus,
  updateProjectMode,
  getDomainsByProjectId,
  countUserDeploymentsToday,
  getActiveDeployment,
} from "../db";
import { provisionBindings } from "../provisioning/provision";
import { addQueueConsumer } from "../provisioning/cloudflare-api";
import { runRemoteMigrations, type RemoteMigration } from "../migrations/remote-runner";
import { validateMigrationSQL } from "../migrations/validate";
import { getPlanLimits, isWithinLimit } from "../tiers";
import { SITE_DOMAIN } from "../constants";
import {
  collectAssets,
  createAssetUploadSession,
  uploadAssetBuckets,
  buildAssetMetadata,
  PASSTHROUGH_WORKER,
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
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC without a Z suffix.
    // Normalize to ISO 8601 so Date parses it as UTC, not local time.
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
    : { version: 2, bindings: {} };

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
  const workerName = `user-${project.slug}`;

  try {
    await updateDeploymentStatus(c.get("db"), deployment.id, "uploading");

    // Collect assets from FormData and compute CF-compatible hashes
    const { manifest: assetManifest, assetsByHash } = await collectAssets(formData);
    const assetCount = Object.keys(assetManifest).length;

    // Determine if this is a static-only deploy (no worker files in FormData)
    const hasWorkerFiles = [...formData.keys()].some((k) => k.startsWith("worker:"));
    const isStaticOnly = !hasWorkerFiles;

    // Upload assets via CF asset upload API (3-step flow)
    let completionJwt: string | undefined;
    if (assetCount > 0) {
      const session = await createAssetUploadSession(
        c.env.CF_ACCOUNT_ID,
        c.env.CF_API_TOKEN,
        dispatchNamespace,
        workerName,
        assetManifest,
      );
      completionJwt = session.jwt;

      if (session.buckets.length > 0) {
        await uploadAssetBuckets(
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          session.jwt,
          session.buckets,
          assetsByHash,
        );
      }
    }

    // Fetch domains once — used in both static-only and full deploy paths
    const projectDomains = await getDomainsByProjectId(c.get("db"), projectId);

    if (isStaticOnly) {
      // Static-only deploy: generate passthrough worker, skip bindings/migrations
      const assetConfig = manifest.assetConfig ?? { not_found_handling: "single-page-application" };
      const workerFormData = new FormData();

      const metadata: Record<string, unknown> = {
        main_module: "index.js",
        compatibility_date: "2026-02-12",
        compatibility_flags: ["nodejs_compat"],
        bindings: [{ name: "ASSETS", type: "assets" }],
        ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
      };
      workerFormData.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
      workerFormData.append(
        "index.js",
        new Blob([PASSTHROUGH_WORKER], { type: "application/javascript+module" }),
        "index.js",
      );

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
        const msg = `worker upload failed: ${error}`;
        await updateDeploymentStatus(c.get("db"), deployment.id, "failed", msg);
        return c.json({ error: "worker upload failed", details: error }, 502);
      }

      // Derive project mode from assetConfig
      const mode = assetConfig.not_found_handling === "single-page-application" ? "spa" : "ssg";

      // Update KV routing
      const existingRouting = await c.env.ROUTING.get(project.slug);
      const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
      const routingJson = JSON.stringify({
        workerName,
        projectId,
        userId: project.user_id,
        version: deployment.id,
        ...(existingEntry?.suspended ? { suspended: existingEntry.suspended } : {}),
      });
      await c.env.ROUTING.put(project.slug, routingJson);

      for (const domain of projectDomains) {
        if (domain.status === "active") {
          await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
        }
      }

      await updateDeploymentStatus(c.get("db"), deployment.id, "live");
      await updateProjectMode(c.get("db"), projectId, mode);

      const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
      const activeDomains = projectDomains.filter((d) => d.status === "active");
      const url =
        activeDomains.length > 0
          ? `https://${activeDomains[0].hostname}`
          : `https://${project.slug}.${siteDomain}`;

      return c.json({
        deployment: deployment.id,
        url,
        urls: [
          ...activeDomains.map((d) => `https://${d.hostname}`),
          `https://${project.slug}.${siteDomain}`,
        ],
        assets: assetCount,
        workers: 1,
      });
    }

    // Full deploy path
    // Provision bindings (D1, KV, R2) — creates CF resources if needed
    const workerBindings = await provisionBindings(
      c.get("db"),
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
      projectId,
      manifest,
      c.env.JWT_SECRET,
    );

    // 1. Run migrations (before worker deploy — key invariant)
    let migrationsApplied = 0;
    const migrationEntries: RemoteMigration[] = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("migration:")) {
        const name = key.slice("migration:".length);
        const sql = await (value as Blob).text();

        // Server-side validation (defense in depth)
        const validation = validateMigrationSQL(sql);
        if (!validation.allowed) {
          const msg = `destructive migration rejected: ${name}`;
          await updateDeploymentStatus(c.get("db"), deployment.id, "failed", msg);
          return c.json({ error: msg }, 400);
        }

        migrationEntries.push({ name, sql });
      }
    }

    if (migrationEntries.length > 0) {
      const d1Resource = workerBindings.find((b) => b.type === "d1");
      if (!d1Resource || !d1Resource.id) {
        const msg = "migrations require a D1 database but none is provisioned";
        await updateDeploymentStatus(c.get("db"), deployment.id, "failed", msg);
        return c.json({ error: msg }, 400);
      }

      await updateDeploymentStatus(c.get("db"), deployment.id, "migrating");

      try {
        const result = await runRemoteMigrations(
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          d1Resource.id,
          migrationEntries,
        );
        migrationsApplied = result.applied.length;
      } catch (err) {
        const msg = `migration failed: ${err instanceof Error ? err.message : String(err)}`;
        await updateDeploymentStatus(c.get("db"), deployment.id, "failed", msg);
        return c.json(
          {
            error: "migration failed",
            details: err instanceof Error ? err.message : String(err),
          },
          502,
        );
      }
    }

    // 2. Upload worker to dispatch namespace via CF API
    const workerFormData = new FormData();

    // Collect all worker modules
    const workerFiles: { name: string; content: Blob }[] = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("worker:")) {
        const filePath = key.slice("worker:".length);
        workerFiles.push({ name: filePath, content: value as Blob });
      }
    }

    // Build combined bindings: user vars + provisioned (d1/kv/r2) + ASSETS
    // Platform bindings come LAST so they win on name collision (CF uses last-wins semantics)
    const RESERVED_BINDING_NAMES = new Set(["__AI_PROXY", "__PROJECT_ID", "__AI_TOKEN", "ASSETS"]);

    const userVarNames = Object.keys(manifest.vars ?? {});
    const reserved = userVarNames.filter((n) => RESERVED_BINDING_NAMES.has(n));
    if (reserved.length > 0) {
      const msg = `reserved binding names: ${reserved.join(", ")}`;
      await updateDeploymentStatus(c.get("db"), deployment.id, "failed", msg);
      return c.json({ error: msg }, 400);
    }

    const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
      type: "plain_text" as const,
      name,
      text,
    }));
    const allBindings = [
      ...plainTextBindings,
      ...workerBindings,
      { name: "ASSETS", type: "assets" },
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
      triggers:
        manifest.schedules && manifest.schedules.length > 0
          ? { crons: manifest.schedules.map((schedule) => schedule.cron) }
          : undefined,
      ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
    };
    workerFormData.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    );

    // Add each worker module
    for (const file of workerFiles) {
      workerFormData.append(file.name, file.content, file.name);
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
      const msg = `worker upload failed: ${error}`;
      await updateDeploymentStatus(c.get("db"), deployment.id, "failed", msg);
      return c.json({ error: "worker upload failed", details: error }, 502);
    }

    // 2b. Configure queue consumers (dispatch worker relays to user workers)
    const dispatchWorkerName = c.env.DISPATCH_WORKER_NAME ?? "void-dispatch";
    await Promise.all(
      (manifest.queues ?? []).map(async (q) => {
        const queueBinding = workerBindings.find(
          (b) => b.type === "queue" && b.name === q.bindingName,
        );
        if (queueBinding?.queue_name) {
          try {
            await addQueueConsumer(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              queueBinding.queue_name,
              dispatchWorkerName,
              {
                ...(q.maxBatchSize != null && { max_batch_size: q.maxBatchSize }),
                ...(q.maxBatchTimeout != null && { max_batch_timeout: q.maxBatchTimeout }),
              },
            );
          } catch {
            // Consumer may already exist — idempotent
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

    // 3. Clear previous ISR cache on deploy.
    // Always clear — handles both "new deploy has ISR" and "previous deploy had ISR
    // but new one doesn't" (avoids orphaned R2 entries). No-op for empty prefixes.
    await clearIsrCache(c.env.ASSETS, projectId);

    // 3b. Prerender pages (write ISR cache entries before going live)
    if (manifest.prerender && manifest.prerender.length > 0 && manifest.revalidate) {
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
            const r2Key = isrR2Key(projectId, pathname);
            const headers = serializePrerenderHeaders(response);
            const body = await response.arrayBuffer();

            await c.env.ASSETS.put(r2Key, body, {
              customMetadata: {
                status: String(response.status),
                createdAt: String(Date.now()),
                ttl: String(ttl),
                headers: JSON.stringify(headers),
              },
            });
          }
        } catch {
          // Prerender failures are non-blocking — page will be rendered on first request
        }
      });
    }

    // 4. Update KV routing table
    // Carry forward suspended flag from current KV entry
    const existingRouting = await c.env.ROUTING.get(project.slug);
    const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
    // Include per-request limits for dispatch enforcement
    const dispatchLimits =
      planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
        ? {
            limits: {
              ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
              ...(planLimits.subRequestsPerInvocation > 0
                ? { subRequests: planLimits.subRequestsPerInvocation }
                : {}),
            },
          }
        : {};
    const routingJson = JSON.stringify({
      workerName,
      projectId,
      userId: project.user_id,
      ...(manifest.ssr ? { ssr: true } : {}),
      ...(manifest.revalidate ? { revalidate: manifest.revalidate } : {}),
      version: deployment.id,
      ...dispatchLimits,
      ...(existingEntry?.suspended ? { suspended: existingEntry.suspended } : {}),
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
    await updateProjectMode(c.get("db"), projectId, manifest.framework ? "framework" : "fullstack");

    const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
    const activeDomains = projectDomains.filter((d) => d.status === "active");
    const fullUrl =
      activeDomains.length > 0
        ? `https://${activeDomains[0].hostname}`
        : `https://${project.slug}.${siteDomain}`;

    return c.json({
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
    throw err;
  }
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

async function clearIsrCache(assets: R2Bucket, projectId: string): Promise<void> {
  const prefix = `${projectId}/isr/`;
  let cursor: string | undefined;

  do {
    const listed = await assets.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await uploadPool(listed.objects, R2_CONCURRENCY, (obj) => assets.delete(obj.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// --- ISR prerender helpers (inlined from dispatch to avoid cross-package dependency) ---

/**
 * Build the R2 key for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
function isrR2Key(projectId: string, pathname: string): string {
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

export default app;
