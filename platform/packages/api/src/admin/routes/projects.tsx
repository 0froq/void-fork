import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  deleteOperatorProject,
  previewOperatorProjectOwner,
  transferOperatorProjectOwner,
} from '../../operator/tenant-service.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderFateDetailPage, renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

function transferTarget(body: Record<string, string | File>) {
  const value = body.userId;
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new OperatorError(400, 'New owner user ID is required.');
  }
  return value.trim();
}

// GET /projects
app.get('/', (context) => renderFateListPage(context, 'projects'));

// GET /projects/:id
app.get('/:id', (context) => renderFateDetailPage(context, 'projectDetail'));

// POST /projects/:id/owner/preview
app.post('/:id/owner/preview', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const userId = transferTarget(body);
  const result = await previewOperatorProjectOwner(context, projectId, userId);
  const convergenceOnly = !result.changed;
  const operationBlocked = result.blockers.some(
    (blocker) => !convergenceOnly || blocker.kind === 'deletion',
  );

  return renderAdminPage(
    context,
    'projectOwnerPreview',
    `${convergenceOnly ? 'Converge' : 'Transfer'} ${result.target.slug}`,
    {
      result,
      convergenceOnly,
      operationBlocked,
      projectId,
      userId,
      platformName: getPlatformDisplayName(context.env, context.req.url),
      username: context.get('user').login,
    },
  );
});

// POST /projects/:id/owner
app.post('/:id/owner', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const userId = transferTarget(body);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/owner`, { userId }),
    async () => {
      await transferOperatorProjectOwner(context, projectId, userId);
      return { response: context.redirect(`/admin/projects/${projectId}`), succeeded: true };
    },
  );
});

// POST /projects/:id/delete
app.post('/:id/delete', async (context) => {
  const projectId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/delete`),
    async () => {
      await deleteOperatorProject(context, projectId);
      return { response: context.redirect('/admin/projects'), succeeded: true };
    },
  );
});

export default app;
