import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal worker name resolution — called by the proxy via service binding.
 * Returns the WfP worker name (user-<slug>) for a given projectId.
 * Authenticated via HMAC token in X-Void-Internal header (same as resolve-resource).
 *
 * POST /internal/resolve-worker/:projectId
 * Returns: { "workerName": "user-<slug>" } or 404
 */
app.post('/:projectId', async (c) => {
  const projectId = c.req.param('projectId');

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

  return c.json({ workerName: `user-${project.slug}` });
});

export default app;
