import { Hono } from 'hono';
import { getProject, deleteProjectCascade } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { cleanupProjectResources } from '../provisioning/cleanup.ts';

const app = new Hono<ApiEnv>();

app.delete('/:id', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const warnings = await cleanupProjectResources(c, projectId, project);

  // Atomic DB cleanup (domains, resources, deployments, project)
  await deleteProjectCascade(c.get('db'), projectId);

  return c.json({
    ok: true,
    id: projectId,
    slug: project.slug,
    ...(warnings.length > 0 && { warnings }),
  });
});

export default app;
