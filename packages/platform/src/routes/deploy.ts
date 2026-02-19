import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import type { DeployManifest } from "../types";
import {
  getProject,
  getUser,
  createDeployment,
  updateDeploymentStatus,
  updateProjectMode,
  getDomainsByProjectId,
  countUserDeploymentsToday,
} from "../db";
import { provisionBindings } from "../provisioning/provision";
import { runRemoteMigrations, type RemoteMigration } from "../migrations/remote-runner";
import { validateMigrationSQL } from "../migrations/validate";
import { getPlanLimits, isWithinLimit } from "../tiers";

const DEFAULT_DISPATCH_NAMESPACE = "vite-cloud-users";
const DEFAULT_SITE_DOMAIN = "vitecloud.app";
const R2_CONCURRENCY = 6; // Workers allow 6 simultaneous open connections

const app = new Hono<PlatformEnv>();

// Check which assets need uploading
app.post("/:id/assets/check", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const { assets } = await c.req.json<{ assets: Record<string, string> }>();
  const manifestObj = await c.env.ASSETS.get(`${projectId}/asset-manifest.json`);
  const existing: Record<string, string> = manifestObj ? await manifestObj.json() : {};
  const needed = Object.keys(assets).filter((path) => existing[path] !== assets[path]);
  return c.json({ needed });
});

// Deploy to a project
app.post("/:id/deploy", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Enforce deploy count limit
  const user = await getUser(c.env.DB, c.get("userId"));
  const planLimits = getPlanLimits(user?.plan ?? "free");
  if (planLimits.deploysPerDay > 0) {
    const todayCount = await countUserDeploymentsToday(c.env.DB, c.get("userId"));
    if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
      return c.json({ error: "deploy limit exceeded", limit: planLimits.deploysPerDay }, 429);
    }
  }

  const formData = await c.req.formData();
  const manifestRaw = formData.get("manifest") as string | null;
  const manifest: DeployManifest = manifestRaw
    ? (JSON.parse(manifestRaw) as DeployManifest)
    : { bindings: {} };
  const source = (formData.get("source") as string | null) ?? null;

  // Create deployment record
  const deployment = await createDeployment(c.env.DB, projectId, manifestRaw, source);

  try {
    // Static-only deploy path: skip worker upload, bindings, and migrations
    if (manifest.static) {
      await updateDeploymentStatus(c.env.DB, deployment.id, "uploading");

      // Upload static assets to R2 (concurrency-limited to match Workers connection limit)
      const assetUploads = collectAssetEntries(formData);
      await uploadPool(assetUploads, R2_CONCURRENCY, ({ path, blob }) =>
        c.env.ASSETS.put(`${projectId}/current/${path}`, blob, {
          httpMetadata: { contentType: guessContentType(path) },
        }),
      );
      const assetKeys = assetUploads.map((a) => a.path);

      // Write updated asset manifest + delete stale assets
      if (manifest.assetHashes) {
        const oldObj = await c.env.ASSETS.get(`${projectId}/asset-manifest.json`);
        const oldManifest: Record<string, string> = oldObj ? await oldObj.json() : {};
        const stale = Object.keys(oldManifest).filter((p) => !(p in manifest.assetHashes!));
        if (stale.length > 0) {
          await uploadPool(stale, R2_CONCURRENCY, (path) =>
            c.env.ASSETS.delete(`${projectId}/current/${path}`),
          );
        }
        await c.env.ASSETS.put(
          `${projectId}/asset-manifest.json`,
          JSON.stringify(manifest.assetHashes),
        );
      }

      // Update KV routing (no workerName for static deploys)
      // Carry forward suspended flag from current KV entry
      const existingStaticRouting = await c.env.ROUTING.get(project.slug);
      const existingStaticEntry = existingStaticRouting ? JSON.parse(existingStaticRouting) : null;
      const staticRoutingJson = JSON.stringify({
        projectId,
        mode: manifest.static,
        version: deployment.id,
        ...(manifest.headers ? { headers: manifest.headers } : {}),
        ...(existingStaticEntry?.suspended ? { suspended: existingStaticEntry.suspended } : {}),
      });
      await c.env.ROUTING.put(project.slug, staticRoutingJson);

      // Update KV routing for active custom domains
      const staticDomains = await getDomainsByProjectId(c.env.DB, projectId);
      for (const domain of staticDomains) {
        if (domain.status === "active") {
          await c.env.ROUTING.put(`domain:${domain.hostname}`, staticRoutingJson);
        }
      }

      // Mark deployment as live + update project mode
      await updateDeploymentStatus(c.env.DB, deployment.id, "live");
      await updateProjectMode(c.env.DB, projectId, manifest.static);

      const siteDomain = c.env.SITE_DOMAIN ?? DEFAULT_SITE_DOMAIN;
      const staticActiveDomains = staticDomains.filter((d) => d.status === "active");
      const staticUrl =
        staticActiveDomains.length > 0
          ? `https://${staticActiveDomains[0].hostname}`
          : `https://${project.slug}.${siteDomain}`;

      return c.json({
        deployment: deployment.id,
        url: staticUrl,
        urls: [
          ...staticActiveDomains.map((d) => `https://${d.hostname}`),
          `https://${project.slug}.${siteDomain}`,
        ],
        assets: assetKeys.length,
        workers: 0,
      });
    }

    // Full deploy path (existing behavior)
    await updateDeploymentStatus(c.env.DB, deployment.id, "uploading");

    // Provision bindings (D1, KV, R2) — creates CF resources if needed
    const workerBindings = await provisionBindings(
      c.env.DB,
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
      projectId,
      manifest,
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
          await updateDeploymentStatus(c.env.DB, deployment.id, "failed", msg);
          return c.json({ error: msg }, 400);
        }

        migrationEntries.push({ name, sql });
      }
    }

    if (migrationEntries.length > 0) {
      // Find the D1 resource for this project
      const d1Resource = workerBindings.find((b) => b.type === "d1");
      if (!d1Resource || !d1Resource.id) {
        const msg = "migrations require a D1 database but none is provisioned";
        await updateDeploymentStatus(c.env.DB, deployment.id, "failed", msg);
        return c.json({ error: msg }, 400);
      }

      await updateDeploymentStatus(c.env.DB, deployment.id, "migrating");

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
        await updateDeploymentStatus(c.env.DB, deployment.id, "failed", msg);
        return c.json(
          {
            error: "migration failed",
            details: err instanceof Error ? err.message : String(err),
          },
          502,
        );
      }
    }

    // 2. Upload static assets to R2 (concurrency-limited to match Workers connection limit)
    const assetUploads = collectAssetEntries(formData);
    await uploadPool(assetUploads, R2_CONCURRENCY, ({ path, blob }) =>
      c.env.ASSETS.put(`${projectId}/current/${path}`, blob, {
        httpMetadata: { contentType: guessContentType(path) },
      }),
    );
    const assetKeys = assetUploads.map((a) => a.path);

    // 3. Upload worker to dispatch namespace via CF API
    const workerName = `user-${project.slug}`;
    const workerFormData = new FormData();

    // Collect all worker modules
    const workerFiles: { name: string; content: Blob }[] = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("worker:")) {
        const filePath = key.slice("worker:".length);
        workerFiles.push({ name: filePath, content: value as Blob });
      }
    }

    // Build combined bindings: provisioned (d1/kv/r2) + plain_text vars from .env
    const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
      type: "plain_text" as const,
      name,
      text,
    }));
    const allBindings = [...workerBindings, ...plainTextBindings];

    // Add metadata part (include provisioned bindings)
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2026-02-12",
      compatibility_flags: ["nodejs_compat"],
      bindings: allBindings.length > 0 ? allBindings : undefined,
      triggers:
        manifest.schedules && manifest.schedules.length > 0
          ? { crons: manifest.schedules.map((schedule) => schedule.cron) }
          : undefined,
    };
    workerFormData.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    );

    // Add each worker module
    for (const file of workerFiles) {
      workerFormData.append(
        file.name,
        new Blob([await file.content.arrayBuffer()], {
          type: "application/javascript+module",
        }),
        file.name,
      );
    }

    // Upload to CF Workers for Platforms API
    const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
    const cfResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
        },
        body: workerFormData,
      },
    );

    if (!cfResponse.ok) {
      const error = await cfResponse.text();
      const msg = `worker upload failed: ${error}`;
      await updateDeploymentStatus(c.env.DB, deployment.id, "failed", msg);
      return c.json({ error: "worker upload failed", details: error }, 502);
    }

    // 4. Write updated asset manifest + delete stale assets
    if (manifest.assetHashes) {
      const oldObj = await c.env.ASSETS.get(`${projectId}/asset-manifest.json`);
      const oldManifest: Record<string, string> = oldObj ? await oldObj.json() : {};
      const stale = Object.keys(oldManifest).filter((p) => !(p in manifest.assetHashes!));
      if (stale.length > 0) {
        await uploadPool(stale, R2_CONCURRENCY, (path) =>
          c.env.ASSETS.delete(`${projectId}/current/${path}`),
        );
      }
      await c.env.ASSETS.put(
        `${projectId}/asset-manifest.json`,
        JSON.stringify(manifest.assetHashes),
      );
    }

    // 5. Clear previous ISR cache on deploy
    const hasIsr =
      typeof manifest.revalidate === "object"
        ? Object.keys(manifest.revalidate).length > 0
        : Boolean(manifest.revalidate && manifest.revalidate > 0);
    if (hasIsr) {
      await clearIsrCache(c.env.ASSETS, projectId);
    }

    // 6. Update KV routing table
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
      ...(manifest.ssr ? { ssr: true } : {}),
      ...(manifest.revalidate ? { revalidate: manifest.revalidate } : {}),
      version: deployment.id,
      ...(manifest.headers ? { headers: manifest.headers } : {}),
      ...dispatchLimits,
      ...(existingEntry?.suspended ? { suspended: existingEntry.suspended } : {}),
    });
    await c.env.ROUTING.put(project.slug, routingJson);

    // Update KV routing for active custom domains
    const fullDomains = await getDomainsByProjectId(c.env.DB, projectId);
    for (const domain of fullDomains) {
      if (domain.status === "active") {
        await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
      }
    }

    // 7. Mark deployment as live + update project mode
    await updateDeploymentStatus(c.env.DB, deployment.id, "live");
    await updateProjectMode(c.env.DB, projectId, manifest.framework ? "framework" : "fullstack");

    const siteDomain = c.env.SITE_DOMAIN ?? DEFAULT_SITE_DOMAIN;
    const fullActiveDomains = fullDomains.filter((d) => d.status === "active");
    const fullUrl =
      fullActiveDomains.length > 0
        ? `https://${fullActiveDomains[0].hostname}`
        : `https://${project.slug}.${siteDomain}`;

    return c.json({
      deployment: deployment.id,
      url: fullUrl,
      urls: [
        ...fullActiveDomains.map((d) => `https://${d.hostname}`),
        `https://${project.slug}.${siteDomain}`,
      ],
      assets: assetKeys.length,
      workers: workerFiles.length,
      ...(migrationsApplied > 0 && { migrations: migrationsApplied }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateDeploymentStatus(c.env.DB, deployment.id, "failed", msg);
    throw err;
  }
});

function collectAssetEntries(formData: FormData): { path: string; blob: Blob }[] {
  const entries: { path: string; blob: Blob }[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("asset:")) {
      entries.push({ path: key.slice("asset:".length), blob: value as Blob });
    }
  }
  return entries;
}

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

function guessContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    txt: "text/plain",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

export default app;
