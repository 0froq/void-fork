import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import type { DeployManifest } from "../types";
import { getProject, createDeployment, updateDeploymentStatus } from "../db";
import { provisionBindings } from "../provisioning/provision";
import { runRemoteMigrations, type RemoteMigration } from "../migrations/remote-runner";
import { validateMigrationSQL } from "../migrations/validate";

const DISPATCH_NAMESPACE = "vite-cloud-users";

const app = new Hono<PlatformEnv>();

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

  // Create deployment record
  const deployment = await createDeployment(c.env.DB, projectId, manifestRaw);

  try {
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

    // 2. Upload static assets to R2
    const assetKeys: string[] = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("asset:")) {
        const assetPath = key.slice("asset:".length);
        const r2Key = `${projectId}/current/${assetPath}`;
        const blob = value as Blob;
        await c.env.ASSETS.put(r2Key, await blob.arrayBuffer(), {
          httpMetadata: {
            contentType: guessContentType(assetPath),
          },
        });
        assetKeys.push(assetPath);
      }
    }

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

    // 4. Update KV routing table
    await c.env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName, projectId, ...(manifest.ssr ? { ssr: true } : {}) }),
    );

    // 5. Mark deployment as live
    await updateDeploymentStatus(c.env.DB, deployment.id, "live");

    return c.json({
      deployment: deployment.id,
      url: `https://${project.slug}.vitecloud.app`,
      assets: assetKeys.length,
      workers: workerFiles.length,
      ...(migrationsApplied > 0 && { migrations: migrationsApplied }),
    });
  } catch (err) {
    await updateDeploymentStatus(c.env.DB, deployment.id, "failed");
    throw err;
  }
});

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
