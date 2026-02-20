import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import { getProject } from "../db";

const R2_CONCURRENCY = 6;

const app = new Hono<PlatformEnv>();

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

    do {
      const listed = await c.env.ASSETS.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await uploadPool(listed.objects, R2_CONCURRENCY, (obj) => c.env.ASSETS.delete(obj.key));
        purged += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

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

  return c.json({ purged });
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

export default app;
