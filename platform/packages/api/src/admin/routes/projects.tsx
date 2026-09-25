import { Hono } from 'hono';
import { SITE_DOMAIN } from '../../constants.ts';
import { getAllProjectsWithOwner, countProjects, searchProjects } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  deleteOperatorProject,
  getOperatorProject,
  previewOperatorProjectOwner,
  transferOperatorProjectOwner,
} from '../../operator/tenant-service.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { projectUrl, projectWithUrl } from '../../project-url.ts';
import { renderOperationError } from '../operation-error.tsx';
import { renderAdminPage } from '../react/server.ts';

const PAGE_SIZE = 20;
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
app.get('/', async (context) => {
  const search = context.req.query('search');
  const siteDomain = context.env.SITE_DOMAIN ?? SITE_DOMAIN;
  if (search) {
    const projects = await searchProjects(context.get('db'), search);
    return renderAdminPage(context, 'projects', 'Projects', {
      platformName: getPlatformDisplayName(context.env, context.req.url),
      projects: projects.map((project) => projectWithUrl(project, context.env)),
      search,
      siteDomain,
      username: context.get('user').login,
    });
  }
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [projects, total] = await Promise.all([
    getAllProjectsWithOwner(context.get('db'), PAGE_SIZE, offset),
    countProjects(context.get('db')),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return renderAdminPage(context, 'projects', 'Projects', {
    platformName: getPlatformDisplayName(context.env, context.req.url),
    projects: projects.map((project) => projectWithUrl(project, context.env)),
    page,
    totalPages,
    siteDomain,
    username: context.get('user').login,
  });
});

// GET /projects/:id
app.get('/:id', async (context) => {
  const { project, deployments, resources, owner, domains, builds } = await getOperatorProject(
    context.get('db'),
    context.req.param('id'),
  );

  const cfAccountId = context.env.CF_ACCOUNT_ID;
  const deployUrl = projectUrl(project, context.env);
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;

  return renderAdminPage(context, 'projectDetail', project.slug, {
    project,
    deployments,
    resources,
    owner,
    domains,
    builds,
    cfAccountId,
    deployUrl,
    tz,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
});

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
