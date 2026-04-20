import { Hono } from 'hono';
import { getProject } from '../db';
import type { ApiEnv } from '../env';
import { runRevalidate } from '../revalidate-core';

const app = new Hono<ApiEnv>();

app.post('/:id/revalidate', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json<{ paths?: string[]; all?: boolean }>();
  return runRevalidate(c, projectId, project, body);
});

export default app;
