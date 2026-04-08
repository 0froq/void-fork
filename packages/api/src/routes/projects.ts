import { Hono } from 'hono';
import { hmacSignState } from '../auth/hmac';
import {
  createProject,
  getProject,
  getProjectBySlug,
  getProjectsByUserId,
  getProjectDeployments,
  getProjectResources,
  getDomainsByProjectId,
  getDomainsByProjectIds,
  getDeployment,
  setActiveDeployment,
} from '../db';
import type { ApiEnv } from '../env';
import { queryD1 } from '../migrations/remote-runner';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../naming';
import { buildRoutingJson, buildStaticRoutingJson } from '../routing';
import { getPlanLimits } from '../tiers';
import type { DeployManifest } from '../types';

export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'cname',
  'dash',
  'dashboard',
  'docs',
  'ftp',
  'gateway',
  'help',
  'imap',
  'login',
  'mail',
  'ns1',
  'ns2',
  'ns3',
  'ns4',
  'oauth',
  'pop',
  'proxy',
  'register',
  'signup',
  'smtp',
  'sso',
  'staging',
  'static',
  'status',
  'support',
  'www',
]);

const app = new Hono<ApiEnv>()

  // List all projects for the current user
  .get('/', async (c) => {
    const userId = c.get('user').id;
    const projects = await getProjectsByUserId(c.get('db'), userId);

    // Batch-fetch domains for all projects in a single query
    const projectIds = projects.map((p) => p.id);
    const domainMap =
      projectIds.length > 0 ? await getDomainsByProjectIds(c.get('db'), projectIds) : new Map();

    const projectsWithDomains = projects.map((p) => {
      const pDomains = domainMap.get(p.id);
      const domain =
        pDomains?.find((d: { status: string }) => d.status === 'active') ?? pDomains?.[0];
      return { ...p, custom_domain: domain?.hostname ?? null };
    });

    return c.json(projectsWithDomains);
  })

  // Create a new project
  .post('/', async (c) => {
    const body = await c.req.json<{ slug: string }>();

    if (!body.slug) {
      return c.json({ error: 'slug is required' }, 400);
    }

    // Validate slug format: lowercase alphanumeric + dashes, no leading/trailing dashes
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.slug)) {
      return c.json({ error: 'slug must be lowercase alphanumeric with dashes' }, 400);
    }

    if (RESERVED_SLUGS.has(body.slug)) {
      return c.json({ error: 'this name is reserved' }, 400);
    }

    // Short slugs (5 chars or fewer) are reserved for paid plans
    if (body.slug.length <= 5) {
      if (c.get('user').plan === 'free') {
        return c.json({ error: 'short slugs (5 characters or fewer) require a paid plan' }, 403);
      }
    }

    // Check for slug uniqueness
    const existing = await getProjectBySlug(c.get('db'), body.slug);
    if (existing) {
      return c.json({ error: 'slug already taken' }, 409);
    }

    const userId = c.get('user').id;
    try {
      const project = await createProject(c.get('db'), userId, body.slug);
      return c.json(project, 201);
    } catch (err) {
      // Unique constraint violation — slug was taken between check and insert
      if (
        err instanceof Error &&
        err.message.includes('duplicate key value violates unique constraint')
      ) {
        return c.json({ error: 'slug already taken' }, 409);
      }
      throw err;
    }
  })

  // Get project by ID
  .get('/:id', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json(project);
  })

  // List deployments for a project
  .get('/:id/deployments', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const deployments = await getProjectDeployments(c.get('db'), project.id, 20);
    return c.json({
      deployments,
      activeDeploymentId: project.active_deployment_id,
    });
  })

  // Rollback to a previous deployment
  .post('/:id/rollback', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const { deploymentId } = await c.req.json<{ deploymentId: string }>();
    if (!deploymentId) {
      return c.json({ error: 'deploymentId is required' }, 400);
    }

    const target = await getDeployment(c.get('db'), deploymentId);
    if (!target || target.project_id !== projectId) {
      return c.json({ error: 'deployment not found' }, 404);
    }
    if (!target.retained) {
      return c.json({ error: 'deployment not retained (worker script evicted)' }, 400);
    }

    // Compute migration diff
    const currentActive = project.active_deployment_id
      ? await getDeployment(c.get('db'), project.active_deployment_id)
      : null;
    const currentMigrations: string[] = currentActive?.applied_migrations
      ? JSON.parse(currentActive.applied_migrations)
      : [];
    const targetMigrations: string[] = target.applied_migrations
      ? JSON.parse(target.applied_migrations)
      : [];
    const migrationDiff = currentMigrations.filter((m) => !targetMigrations.includes(m));

    // Build routing JSON from target deployment's manifest
    const workerName = getProjectDeploymentWorkerName(project.slug, target.id);
    const planLimits = getPlanLimits(c.get('user').plan);
    const manifest: DeployManifest | null = target.manifest ? JSON.parse(target.manifest) : null;
    const dispatchLimits =
      planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
        ? {
            ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
            ...(planLimits.subRequestsPerInvocation > 0
              ? { subRequests: planLimits.subRequestsPerInvocation }
              : {}),
          }
        : null;

    // Carry forward suspended flag
    const existingRouting = await c.env.ROUTING.get(project.slug);
    const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;

    const isStaticDeployment = project.type === 'static' || project.type === 'spa';

    let routingJson: string;
    if (isStaticDeployment) {
      const assetConfig = manifest?.assetConfig ?? {
        not_found_handling: project.type === 'spa' ? 'single-page-application' : '404-page',
      };
      routingJson = buildStaticRoutingJson({
        projectId,
        userId: project.user_id,
        deploymentId: target.id,
        assetConfig,
        manifest,
        suspended: existingEntry?.suspended,
      });
    } else {
      routingJson = buildRoutingJson({
        workerName,
        projectId,
        userId: project.user_id,
        manifest,
        deploymentId: target.id,
        dispatchLimits,
        suspended: existingEntry?.suspended,
        hasCrons: !!manifest?.schedules?.length,
      });
    }

    await c.env.ROUTING.put(project.slug, routingJson);

    // Sync cron scheduler to point at the rollback target
    if (manifest?.schedules?.length) {
      const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
      const proxyToken = await hmacSignState(projectId, c.env.JWT_SECRET);
      await c.env.CRON_SCHEDULER.get(cronId).fetch(
        new Request('https://do/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workerName, schedules: manifest.schedules, proxyToken }),
        }),
      );
    } else if (existingEntry?.hasCrons) {
      const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
      await c.env.CRON_SCHEDULER.get(cronId).fetch(
        new Request('https://do/clear', { method: 'POST' }),
      );
    }

    // Update custom domain routing
    const projectDomains = await getDomainsByProjectId(c.get('db'), projectId);
    for (const domain of projectDomains) {
      if (domain.status === 'active') {
        await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
      }
    }

    // Update queue routing
    if (manifest?.queues) {
      const projectResources = await getProjectResources(c.get('db'), projectId);
      for (const q of manifest.queues) {
        const queueResource = projectResources.find(
          (r) => r.type === 'queue' && r.binding_name === q.name,
        );
        if (queueResource) {
          await c.env.ROUTING.put(
            `queue:${getProjectQueueName(projectId, q.name)}`,
            JSON.stringify({ workerName, projectId, queueName: q.name }),
          );
        }
      }
    }

    // Clear ISR cache (stale prerendered pages from the current deployment)
    const isrPrefix = `${projectId}/isr/`;
    let cursor: string | undefined;
    do {
      const listed = await c.env.ISR_CACHE.list({ prefix: isrPrefix, cursor });
      for (const key of listed.keys) {
        await c.env.ISR_CACHE.delete(key.name);
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);

    // Update active deployment
    await setActiveDeployment(c.get('db'), projectId, target.id);

    return c.json({ ok: true, deploymentId: target.id, migrationDiff });
  })

  // Get migration status for a project
  .get('/:id/migrations', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }

    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const resources = await getProjectResources(c.get('db'), project.id);
    const d1Resource = resources.find((r) => r.type === 'd1');
    if (!d1Resource) {
      return c.json({ applied: [] });
    }

    try {
      const result = await queryD1(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, d1Resource.cf_id, {
        sql: 'SELECT name, applied_at FROM _migrations ORDER BY name',
      });
      return c.json({
        applied: result.results.map((r) => ({
          name: r.name as string,
          applied_at: r.applied_at as string,
        })),
      });
    } catch {
      return c.json({ applied: [] });
    }
  })

  // List resources for a project
  .get('/:id/resources', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const resources = await getProjectResources(c.get('db'), project.id);
    return c.json(resources);
  })

  // Fetch logs for a project
  .get('/:id/logs', async (c) => {
    const project = await getProject(c.get('db'), c.req.param('id'));
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const since = c.req.query('since') ?? '1h';
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return c.json({ error: 'invalid since parameter, use format like 15m, 2h, 3d' }, 400);
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '200', 10) || 200, 500);
    const deploymentId = c.req.query('deploymentId');
    if (deploymentId && !/^dpl_[0-9a-z]+$/.test(deploymentId)) {
      return c.json({ error: 'invalid deploymentId format' }, 400);
    }
    const workerName = `user-${project.slug}`;
    const sinceStr = new Date(Date.now() - sinceMs).toISOString().replace('T', ' ').slice(0, 19);
    const dataset = c.env.LOGS_DATASET ?? 'void_logs';

    const deployFilter = deploymentId ? `\n        AND blob7 = '${deploymentId}'` : '';
    const query = `
      SELECT
        blob1 as outcome,
        blob2 as logData,
        blob3 as exceptionData,
        blob4 as url,
        blob5 as method,
        blob6 as statusCode,
        blob7 as deployId,
        double1 as ts,
        timestamp
      FROM ${dataset}
      WHERE index1 = '${workerName}'
        AND timestamp >= toDateTime('${sinceStr}')${deployFilter}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
          'Content-Type': 'text/plain',
        },
        body: query,
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error(
        `[logs] query failed for project ${project.id} (${response.status}): ${detail.slice(0, 500)}`,
      );
      return c.json({ error: 'log query failed', status: response.status, detail }, 502);
    }

    const result = (await response.json()) as {
      data: {
        outcome: string;
        logData: string;
        exceptionData: string;
        url: string;
        method: string;
        statusCode: string;
        ts: number;
      }[];
    };

    // Query newest-first to match the working admin path, then return entries
    // in chronological order for CLI readability.
    const data = [...(result.data ?? [])].reverse().map((row) => ({
      timestamp: row.ts,
      outcome: row.outcome,
      logs: tryParse(row.logData),
      exceptions: tryParse(row.exceptionData),
      url: row.url,
      method: row.method,
      status: row.statusCode,
    }));

    return c.json({ data });
  })

  // Provision Hyperdrive for a PostgreSQL project
  .post('/:id/database', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project || project.user_id !== c.get('user').id) {
      return c.json({ error: 'Not found' }, 404);
    }

    const { connectionString } = await c.req.json<{ connectionString: string }>();
    if (!connectionString?.startsWith('postgres')) {
      return c.json({ error: 'Invalid connection string' }, 400);
    }

    const { createHyperdrive, getHyperdriveByName } =
      await import('../provisioning/cloudflare-api');
    const { createResource, getProjectResources } = await import('../db');

    // Check if Hyperdrive already exists
    const existing = await getProjectResources(c.get('db'), projectId);
    const found = existing.find((r) => r.type === 'hyperdrive');
    if (found) {
      return c.json(
        { error: 'Hyperdrive already provisioned. Use PUT /database-url to update.' },
        409,
      );
    }

    const resourceName = `${projectId}-hyperdrive`.toLowerCase();
    let hyperdriveId: string;
    try {
      const hd = await createHyperdrive(
        c.env.CF_ACCOUNT_ID,
        c.env.CF_API_TOKEN,
        resourceName,
        connectionString,
      );
      hyperdriveId = hd.id;
    } catch (err: any) {
      if (err.message?.toLowerCase().includes('already exists')) {
        const hd = await getHyperdriveByName(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, resourceName);
        hyperdriveId = hd.id;
      } else {
        throw err;
      }
    }

    await createResource(c.get('db'), projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
    return c.json({ ok: true });
  })

  // Update PostgreSQL connection string (updates Hyperdrive config)
  .put('/:id/database-url', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project || project.user_id !== c.get('user').id) {
      return c.json({ error: 'Not found' }, 404);
    }

    const { connectionString } = await c.req.json<{ connectionString: string }>();
    if (!connectionString?.startsWith('postgres')) {
      return c.json({ error: 'Invalid connection string' }, 400);
    }

    const { createHyperdrive, updateHyperdrive, getHyperdriveByName } =
      await import('../provisioning/cloudflare-api');
    const { createResource, getProjectResources } = await import('../db');

    const existing = await getProjectResources(c.get('db'), projectId);
    const found = existing.find((r) => r.type === 'hyperdrive');

    if (found) {
      // Update existing Hyperdrive config
      await updateHyperdrive(
        c.env.CF_ACCOUNT_ID,
        c.env.CF_API_TOKEN,
        found.cf_id,
        connectionString,
      );
    } else {
      // Create new Hyperdrive config
      const resourceName = `${projectId}-hyperdrive`.toLowerCase();
      let hyperdriveId: string;
      try {
        const hd = await createHyperdrive(
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          resourceName,
          connectionString,
        );
        hyperdriveId = hd.id;
      } catch (err: any) {
        if (err.message?.toLowerCase().includes('already exists')) {
          const hd = await getHyperdriveByName(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            resourceName,
          );
          hyperdriveId = hd.id;
        } else {
          throw err;
        }
      }
      await createResource(c.get('db'), projectId, 'hyperdrive', hyperdriveId, 'HYPERDRIVE');
    }

    return c.json({ ok: true });
  });

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = value * multipliers[unit];
  if (ms > 7 * 86_400_000) {
    return null;
  } // cap at 7d
  return ms;
}

function tryParse(json: string): unknown[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

export default app;
