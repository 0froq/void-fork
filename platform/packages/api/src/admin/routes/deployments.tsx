import { Hono } from 'hono';
import {
  getAllDeploymentsWithProject,
  countDeployments,
  searchDeployments,
  getDeployment,
  getProject,
} from '../../db.ts';
import { type ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  deploymentLogs,
  requestDeploymentCancellation,
} from '../../operator/deployment-operations.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import type { DeployManifest } from '../../types.ts';
import { renderAdminPage } from '../react/server.ts';

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

const ACTIVE_DEPLOYMENT_STATUSES = new Set(['pending', 'uploading', 'migrating', 'prerendering']);

// GET /deployments
app.get('/', async (context) => {
  const search = context.req.query('search');
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
  if (search) {
    const deployments = await searchDeployments(context.get('db'), search);
    return renderAdminPage(context, 'deployments', 'Deployments', {
      platformName: getPlatformDisplayName(context.env, context.req.url),
      deployments,
      search,
      username: context.get('user').login,
      tz,
    });
  }
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [deployments, total] = await Promise.all([
    getAllDeploymentsWithProject(context.get('db'), PAGE_SIZE, offset),
    countDeployments(context.get('db')),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return renderAdminPage(context, 'deployments', 'Deployments', {
    platformName: getPlatformDisplayName(context.env, context.req.url),
    deployments,
    page,
    totalPages,
    username: context.get('user').login,
    tz,
  });
});

// GET /deployments/:id
app.get('/:id', async (context) => {
  const deployment = await getDeployment(context.get('db'), context.req.param('id'));
  if (!deployment) {
    return context.html('<h1>Deployment not found</h1>', 404);
  }
  const project = await getProject(context.get('db'), deployment.project_id);
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
  const canCancel = ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status);

  let manifest: DeployManifest | null = null;
  try {
    if (deployment.manifest) {
      manifest = JSON.parse(deployment.manifest) as DeployManifest;
    }
  } catch {
    // invalid JSON — skip manifest display
  }

  return renderAdminPage(context, 'deploymentDetail', `Deployment ${deployment.id}`, {
    deployment,
    project,
    manifest,
    canCancel,
    tz,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
});

// POST /deployments/:id/cancel
app.post('/:id/cancel', async (context) => {
  const deploymentId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`deployments/${deploymentId}/cancel`),
    async () => {
      const deployment = await getDeployment(context.get('db'), deploymentId);
      if (!deployment) {
        return {
          response: context.html('<h1>Deployment not found</h1>', 404),
          succeeded: false,
        };
      }

      try {
        await requestDeploymentCancellation(context.get('db'), deployment.id);
      } catch (error) {
        if (error instanceof OperatorError) {
          return { response: context.text(error.message, error.status), succeeded: false };
        }
        throw error;
      }
      return {
        response: context.redirect(`/admin/deployments/${deployment.id}`),
        succeeded: true,
      };
    },
  );
});

// GET /deployments/:id/logs — shared historical log reader.
app.get('/:id/logs', async (context) => {
  try {
    return context.json(
      await deploymentLogs(context.get('db'), context.env, context.req.param('id'), {
        since: context.req.query('since'),
        limit: Number(context.req.query('limit') ?? 100),
        cursor: context.req.query('cursor'),
        order: 'newest-first',
      }),
    );
  } catch (error) {
    if (error instanceof OperatorError) {
      return context.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

export default app;
