import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import type { DeployManifest } from "../types";
import {
  getProject,
  createDeployment,
  updateDeploymentStatus,
  updateProjectMode,
  getDomainsByProjectId,
} from "../db";
import { provisionBindings } from "../provisioning/provision";
import { runRemoteMigrations, type RemoteMigration } from "../migrations/remote-runner";
import { validateMigrationSQL } from "../migrations/validate";

const DISPATCH_NAMESPACE = "vite-cloud-users";
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
      const staticRoutingJson = JSON.stringify({
        projectId,
        mode: manifest.static,
        version: deployment.id,
        ...(manifest.headers ? { headers: manifest.headers } : {}),
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

      const staticActiveDomains = staticDomains.filter((d) => d.status === "active");
      const staticUrl =
        staticActiveDomains.length > 0
          ? `https://${staticActiveDomains[0].hostname}`
          : `https://${project.slug}.vitecloud.app`;

      return c.json({
        deployment: deployment.id,
        url: staticUrl,
        urls: [
          ...staticActiveDomains.map((d) => `https://${d.hostname}`),
          `https://${project.slug}.vitecloud.app`,
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
          await updateDeploymentStatus(c.env.DB, deployment.id, "failed");
          return c.json({ error: `destructive migration rejected: ${name}` }, 400);
        }

        migrationEntries.push({ name, sql });
      }
    }

    if (migrationEntries.length > 0) {
      // Find the D1 resource for this project
      const d1Resource = workerBindings.find((b) => b.type === "d1");
      if (!d1Resource || !d1Resource.id) {
        await updateDeploymentStatus(c.env.DB, deployment.id, "failed");
        return c.json({ error: "migrations require a D1 database but none is provisioned" }, 400);
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
        await updateDeploymentStatus(c.env.DB, deployment.id, "failed");
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

    // Add metadata part (include provisioned bindings)
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2026-02-12",
      compatibility_flags: ["nodejs_compat"],
      bindings: workerBindings.length > 0 ? workerBindings : undefined,
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
    const cfResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/${workerName}`,
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
      await updateDeploymentStatus(c.env.DB, deployment.id, "failed");
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
    if (manifest.revalidate && manifest.revalidate > 0) {
      await clearIsrCache(c.env.ASSETS, projectId);

      // Seed ISR cache from prerendered HTML pages
      if (manifest.ssr) {
        const isrSeeds: { path: string; blob: Blob }[] = [];
        for (const { path, blob } of assetUploads) {
          if (path.endsWith(".html") || path.endsWith("/index.html")) {
            isrSeeds.push({ path, blob });
          }
        }
        if (isrSeeds.length > 0) {
          await uploadPool(isrSeeds, R2_CONCURRENCY, async ({ path, blob }) => {
            // Convert asset path to ISR key: "about/index.html" → "about", "index.html" → "__index__"
            let isrPath = path;
            if (isrPath.endsWith("/index.html")) {
              isrPath = isrPath.slice(0, -"/index.html".length);
            } else if (isrPath === "index.html") {
              isrPath = "__index__";
            } else if (isrPath.endsWith(".html")) {
              isrPath = isrPath.slice(0, -".html".length);
            }
            if (!isrPath) isrPath = "__index__";

            await c.env.ASSETS.put(`${projectId}/isr/${isrPath}`, blob, {
              httpMetadata: { contentType: "text/html" },
              customMetadata: {
                status: "200",
                createdAt: String(Date.now()),
                ttl: String(manifest.revalidate!),
                headers: JSON.stringify({ "Content-Type": "text/html; charset=utf-8" }),
              },
            });
          });
        }
      }
    }

    // 6. Update KV routing table
    const routingJson = JSON.stringify({
      workerName,
      projectId,
      ...(manifest.ssr ? { ssr: true } : {}),
      ...(manifest.revalidate ? { revalidate: manifest.revalidate } : {}),
      version: deployment.id,
      ...(manifest.headers ? { headers: manifest.headers } : {}),
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

    const fullActiveDomains = fullDomains.filter((d) => d.status === "active");
    const fullUrl =
      fullActiveDomains.length > 0
        ? `https://${fullActiveDomains[0].hostname}`
        : `https://${project.slug}.vitecloud.app`;

    return c.json({
      deployment: deployment.id,
      url: fullUrl,
      urls: [
        ...fullActiveDomains.map((d) => `https://${d.hostname}`),
        `https://${project.slug}.vitecloud.app`,
      ],
      assets: assetKeys.length,
      workers: workerFiles.length,
      ...(migrationsApplied > 0 && { migrations: migrationsApplied }),
    });
  } catch (err) {
    await updateDeploymentStatus(c.env.DB, deployment.id, "failed");
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
