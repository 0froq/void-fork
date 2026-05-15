import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { runRevalidate } from '../revalidate-core.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal revalidation endpoint — called by the proxy via service binding.
 * Authenticated via HMAC token in X-Void-Internal header (no JWT/userId).
 */
app.post('/:id', async (c) => {
  const projectId = c.req.param('id');

  // Verify HMAC token
  const token = c.req.header('x-void-internal');
  if (!token) {
    return c.json({ error: 'missing internal auth' }, 401);
  }
  if (!(await hmacVerifyState(projectId, token, c.env.JWT_SECRET))) {
    return c.json({ error: 'invalid internal auth' }, 403);
  }

  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }

  const body = await c.req.json<{ paths?: ReadonlyArray<string>; all?: boolean }>();
  return runRevalidate(c, projectId, project, body);
});

export default app;
