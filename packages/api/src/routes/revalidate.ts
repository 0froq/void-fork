import { Hono, type Context } from "hono";
import type { ApiEnv } from "../env";
import { getProject, getDomainsByProjectId } from "../db";
import { SITE_DOMAIN } from "../constants";
import { purgeZoneCache } from "../provisioning/cloudflare-api";

const R2_CONCURRENCY = 6;

const app = new Hono<ApiEnv>();

app.post("/:id/revalidate", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.get("db"), projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const body = await c.req.json<{ paths?: string[]; all?: boolean }>();

  if (body.all) {
    // Purge all ISR entries for this project
    const prefix = `${projectId}/isr/`;
    let cursor: string | undefined;
    let purged = 0;
    const pathnames: string[] = [];

    do {
      const listed = await c.env.ASSETS.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        for (const obj of listed.objects) {
          const normalized = obj.key.slice(prefix.length);
          pathnames.push(normalized === "__index__" ? "/" : `/${normalized}`);
        }
        await uploadPool(listed.objects, R2_CONCURRENCY, (obj) => c.env.ASSETS.delete(obj.key));
        purged += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    await purgeEdgeCache(c, projectId, project.slug, pathnames);
    return c.json({ purged });
  }

  if (!body.paths || !Array.isArray(body.paths) || body.paths.length === 0) {
    return c.json({ error: "provide `paths` array or `all: true`" }, 400);
  }

  // Purge specific paths
  let purged = 0;
  for (const path of body.paths) {
    let normalized = path;
    if (normalized === "/") {
      normalized = "__index__";
    } else {
      normalized = normalized.startsWith("/") ? normalized.slice(1) : normalized;
      if (normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }
    }
    const key = `${projectId}/isr/${normalized}`;
    await c.env.ASSETS.delete(key);
    purged++;
  }

  await purgeEdgeCache(c, projectId, project.slug, body.paths);
  return c.json({ purged });
});

async function purgeEdgeCache(
  c: Context<ApiEnv>,
  projectId: string,
  slug: string,
  pathnames: string[],
): Promise<void> {
  if (pathnames.length === 0) return;

  try {
    const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
    const hostnames = [`${slug}.${siteDomain}`];

    const customDomains = await getDomainsByProjectId(c.get("db"), projectId);
    for (const d of customDomains) {
      hostnames.push(d.hostname);
    }

    const urls: string[] = [];
    for (const hostname of hostnames) {
      for (const pathname of pathnames) {
        urls.push(`https://${hostname}${pathname}`);
        urls.push(`https://${hostname}${pathname}?__void=json`);
      }
    }

    await purgeZoneCache(c.env.CF_ZONE_ID, c.env.CF_API_TOKEN, urls);
  } catch {
    // Best-effort: R2 is already purged, worst case is stale edge for remaining TTL
  }
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

export default app;
