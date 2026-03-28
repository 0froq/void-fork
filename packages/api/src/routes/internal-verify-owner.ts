import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { getProject } from "../db";
import { hmacVerifyState } from "../auth/hmac";

const app = new Hono<ApiEnv>();

/**
 * Internal ownership verification — called by the proxy via service binding.
 * Used on the JWT auth path to confirm the authenticated user owns the project.
 * Authenticated via HMAC token in X-Void-Internal header.
 *
 * POST /internal/verify-owner/:projectId
 * Body: { "userId": "..." }
 * Returns: 200 { ok: true } or 403 { error: "forbidden" }
 */
app.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

  const token = c.req.header("x-void-internal");
  if (!token) {
    return c.json({ error: "missing internal auth" }, 401);
  }
  if (!(await hmacVerifyState(projectId, token, c.env.JWT_SECRET))) {
    return c.json({ error: "invalid internal auth" }, 403);
  }

  const { userId } = await c.req.json<{ userId: string }>();
  if (!userId) {
    return c.json({ error: "userId required" }, 400);
  }

  const project = await getProject(c.get("db"), projectId);
  if (!project || project.user_id !== userId) {
    return c.json({ error: "forbidden" }, 403);
  }

  return c.json({ ok: true });
});

export default app;
