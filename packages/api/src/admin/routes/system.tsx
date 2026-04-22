import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Handler } from 'hono';
import { DEFAULT_DISPATCH_NAMESPACE, SITE_DOMAIN } from '../../constants';
import type { Db } from '../../db';
import {
  getSystemStats,
  getAllProjectsWithOwner,
  getAllDeploymentsWithProject,
  getProjectsWithOwnerByIds,
} from '../../db';
import { type ApiEnv, isDevBypass } from '../../env';
import { getRequestsDataset, queryTopProjectTraffic } from '../../routes/usage';
import { backfillQueueTokens } from '../backfill-queue-tokens';
import { DashboardPage } from '../views/dashboard';

/** Derive the base cloud domain from the API request hostname.
 *  api.void.cloud → void.cloud, api.staging.void.cloud → staging.void.cloud */
function cloudDomainFromHost(host: string): string {
  return host.replace(/^api\./, '');
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthResult {
  checks: Array<HealthCheck>;
  allOk: boolean;
}

async function checkUrl(
  name: string,
  url: string,
  headers?: Record<string, string>,
): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return { name, ok: res.ok, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

async function checkDb(db: Db): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { name: 'db', ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      name: 'db',
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

function mockHealthResult(): HealthResult {
  const names = ['api', 'proxy', 'dashboard', 'dispatch', 'db'];
  return {
    checks: names.map((name) => ({ name, ok: true, latencyMs: 0 })),
    allOk: true,
  };
}

export const adminSystem = new Hono<ApiEnv>();
const TOP_PROJECT_LIMIT = 10;
const TOP_PROJECT_WINDOW_MS = 60 * 60 * 1000;

async function getTopProjectsLastHour(c: Parameters<Handler<ApiEnv>>[0]) {
  if (isDevBypass(c.env)) {
    return [];
  }

  const topTraffic = await queryTopProjectTraffic(
    c.env.CF_ACCOUNT_ID,
    c.env.CF_API_TOKEN,
    getRequestsDataset(c.env),
    new Date(Date.now() - TOP_PROJECT_WINDOW_MS),
    TOP_PROJECT_LIMIT,
  );
  if (topTraffic.length === 0) {
    return [];
  }

  const projects = await getProjectsWithOwnerByIds(
    c.get('db'),
    topTraffic.map((row) => row.projectId),
  );
  const projectMap = new Map(projects.map((project) => [project.id, project]));

  return topTraffic
    .map((row) => {
      const project = projectMap.get(row.projectId);
      if (!project) {
        return null;
      }
      return {
        ...project,
        requests: row.requests,
        bandwidthBytes: row.bandwidthBytes,
        lastSeen: row.lastSeen,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

adminSystem.get('/health', async (c) => {
  if (isDevBypass(c.env)) {
    return c.json(mockHealthResult());
  }

  const cloudDomain = cloudDomainFromHost(new URL(c.req.url).hostname);
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;

  // API check is implicit — we're serving this request, so the API is up.
  const apiCheck: HealthCheck = { name: 'api', ok: true, latencyMs: 0 };

  const checks = [
    apiCheck,
    ...(await Promise.all([
      checkUrl('proxy', `https://proxy.${cloudDomain}/health`),
      checkUrl('dashboard', `https://dash.${cloudDomain}/login`),
      checkUrl('dispatch', `https://test.${siteDomain}/health`, {
        'X-Health-Check': 'void-admin',
      }),
      checkDb(c.get('db')),
    ])),
  ];

  return c.json({ checks, allOk: checks.every((ch) => ch.ok) } satisfies HealthResult);
});

// One-shot migration endpoint for the queue relay token rollout:
// stamps `proxyToken` on any legacy `queue:*` KV entry written before
// dispatch started forwarding `x-void-internal`. Idempotent — re-running
// only touches entries missing a token.
adminSystem.post('/backfill-queue-tokens', async (c) => {
  const result = await backfillQueueTokens(c.env.ROUTING, {
    accountId: c.env.CF_ACCOUNT_ID,
    apiToken: c.env.CF_API_TOKEN,
    dispatchNamespace: c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE,
    jwtSecret: c.env.JWT_SECRET,
  });
  return c.json(result);
});

export const dashboardHandler: Handler<ApiEnv> = async (c) => {
  const [stats, projects, deployments, topProjects] = await Promise.all([
    getSystemStats(c.get('db')),
    getAllProjectsWithOwner(c.get('db'), 5, 0),
    getAllDeploymentsWithProject(c.get('db'), 5, 0),
    getTopProjectsLastHour(c),
  ]);
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
  return c.html(
    <DashboardPage
      stats={stats}
      projects={projects}
      deployments={deployments}
      topProjects={topProjects}
      siteDomain={siteDomain}
      username={c.get('user').login}
    />,
  );
};
