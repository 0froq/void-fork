import { Hono } from 'hono';
import type { Handler } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { backfillPlatformQueueTokens, systemHealth } from '../../operator/system-operations.ts';
export type { HealthCheck, HealthResult } from '../../operator/system-operations.ts';
import { renderDashboardFatePage, renderFateListPage } from '../fate/render.ts';

export const adminSystem = new Hono<ApiEnv>();

adminSystem.get('/cli-versions', (context) => renderFateListPage(context, 'cliVersions'));

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
  return renderDashboardFatePage(context);
};
