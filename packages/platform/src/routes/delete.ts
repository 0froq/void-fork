import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import {
  getProject,
  getProjectResources,
  deleteProjectResources,
  deleteProjectDeployments,
  deleteProject,
} from "../db";
import {
  deleteD1Database,
  deleteKVNamespace,
  deleteR2Bucket,
} from "../provisioning/cloudflare-api";

const DISPATCH_NAMESPACE = "vite-cloud-users";

const app = new Hono<PlatformEnv>();

app.delete("/:id", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const warnings: string[] = [];
  const resources = await getProjectResources(c.env.DB, projectId);

  // Best-effort CF resource cleanup
  for (const resource of resources) {
    try {
      if (resource.type === "d1") {
        await deleteD1Database(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id);
      } else if (resource.type === "kv") {
        await deleteKVNamespace(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id);
      } else if (resource.type === "r2") {
        await deleteR2Bucket(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resource.cf_id);
      }
    } catch (err) {
      warnings.push(
        `Failed to delete ${resource.type} resource ${resource.cf_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Delete worker from dispatch namespace
  const workerName = `user-${project.slug}`;
  try {
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${DISPATCH_NAMESPACE}/scripts/${workerName}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
        },
      },
    );
    if (!cfRes.ok) {
      const details = await cfRes.text();
      warnings.push(`Failed to delete worker ${workerName}: ${details}`);
    }
  } catch (err) {
    warnings.push(
      `Failed to delete worker ${workerName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Delete R2 assets (paginated)
  try {
    let cursor: string | undefined;
    do {
      const listed = await c.env.ASSETS.list({
        prefix: `${projectId}/`,
        cursor,
      });
      for (const obj of listed.objects) {
        await c.env.ASSETS.delete(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (err) {
    warnings.push(
      `Failed to clean up R2 assets: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Delete KV routing entry
  try {
    await c.env.ROUTING.delete(project.slug);
  } catch (err) {
    warnings.push(
      `Failed to delete routing entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Delete DB records in FK order: resources -> deployments -> project
  await deleteProjectResources(c.env.DB, projectId);
  await deleteProjectDeployments(c.env.DB, projectId);
  await deleteProject(c.env.DB, projectId);

  return c.json({
    ok: true,
    id: projectId,
    slug: project.slug,
    ...(warnings.length > 0 && { warnings }),
  });
});

export default app;
