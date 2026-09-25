import { Hono } from 'hono';
import type { Handler } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import {
  backfillPlatformQueueTokens,
  cliVersionStats,
  systemHealth,
  systemOverview,
} from '../../operator/system-operations.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { projectWithUrl } from '../../project-url.ts';
export type { HealthCheck, HealthResult } from '../../operator/system-operations.ts';
import { renderAdminPage } from '../react/server.ts';

export const adminSystem = new Hono<ApiEnv>();

adminSystem.get('/cli-versions', async (context) => {
  const stats = await cliVersionStats(context.get('db'));
  const tz = (context.req.raw.cf?.timezone as string | undefined) ?? undefined;
  return renderAdminPage(context, 'cliVersions', 'CLI Versions', {
    platformName: getPlatformDisplayName(context.env, context.req.url),
    ...stats,
    username: context.get('user').login,
    tz,
  });
});

adminSystem.get('/health', async (context) =>
  context.json(await systemHealth(context.get('db'), context.env, context.req.url)),
);
adminSystem.post('/backfill-queue-tokens', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('system/backfill-queue-tokens'), async () => {
    const result = await backfillPlatformQueueTokens(context.env);
    return {
      response: context.json(result),
      succeeded: result.errored === 0,
    };
  }),
);

export const dashboardHandler: Handler<ApiEnv> = async (context) => {
  const overview = await systemOverview(context.get('db'), context.env);
  return renderAdminPage(context, 'dashboard', 'Dashboard', {
    platformName: getPlatformDisplayName(context.env, context.req.url),
    ...overview,
    projects: overview.projects.map((project) => projectWithUrl(project, context.env)),
    topProjects: overview.topProjects.map((project) => projectWithUrl(project, context.env)),
    username: context.get('user').login,
  });
};
