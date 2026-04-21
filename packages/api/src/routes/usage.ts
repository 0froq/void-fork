import { Hono } from 'hono';
import { getProject, getProjectsByUserId } from '../db';
import { type ApiEnv, isDevBypass } from '../env';
import { getCurrentBillingPeriodStart } from '../tiers';

const projectUsage = new Hono<ApiEnv>()

  // Project usage for current billing period
  .get('/:id/usage', async (c) => {
    const projectId = c.req.param('id');
    const project = await getProject(c.get('db'), projectId);
    if (!project) {
      return c.json({ error: 'project not found' }, 404);
    }
    if (project.user_id !== c.get('user').id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    // Dev bypass — skip slow CF Analytics Engine API calls
    if (isDevBypass(c.env)) {
      return c.json({
        projectId,
        billingPeriodStart: new Date().toISOString(),
        requests: 0,
        bandwidthBytes: 0,
        aiNeurons: 0,
      });
    }

    const since = getCurrentBillingPeriodStart(c.get('user').billing_cycle_start);
    const requestsDataset = getRequestsDataset(c.env);
    const [usage, aiUsage] = await Promise.all([
      queryProjectUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, requestsDataset, projectId, since),
      queryProjectAiUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, projectId, since),
    ]);

    return c.json({
      projectId,
      billingPeriodStart: since.toISOString(),
      ...usage,
      aiNeurons: aiUsage.neurons,
    });
  });

const accountUsage = new Hono<ApiEnv>()

  // Aggregate usage across all user's projects
  .get('/', async (c) => {
    const projects = await getProjectsByUserId(c.get('db'), c.get('user').id);
    if (projects.length === 0) {
      return c.json({ requests: 0, bandwidthBytes: 0, aiNeurons: 0, projects: [] });
    }

    // Dev bypass — skip slow CF Analytics Engine API calls
    if (isDevBypass(c.env)) {
      return c.json({
        billingPeriodStart: new Date().toISOString(),
        requests: 0,
        bandwidthBytes: 0,
        aiNeurons: 0,
        projects: projects.map((p) => ({
          projectId: p.id,
          slug: p.slug,
          requests: 0,
          bandwidthBytes: 0,
          aiNeurons: 0,
        })),
      });
    }

    const since = getCurrentBillingPeriodStart(c.get('user').billing_cycle_start);
    const requestsDataset = getRequestsDataset(c.env);

    const [usageMap, ...aiUsages] = await Promise.all([
      queryBatchProjectUsage(
        c.env.CF_ACCOUNT_ID,
        c.env.CF_API_TOKEN,
        requestsDataset,
        projects.map((p) => p.id),
        since,
      ),
      ...projects.map((p) =>
        queryProjectAiUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, p.id, since),
      ),
    ]);
    const projectUsages = projects.map((p, i) => ({
      projectId: p.id,
      slug: p.slug,
      ...(usageMap.get(p.id) ?? ZERO_USAGE),
      aiNeurons: aiUsages[i].neurons,
    }));

    const totals = projectUsages.reduce(
      (acc, u) => ({
        requests: acc.requests + u.requests,
        bandwidthBytes: acc.bandwidthBytes + u.bandwidthBytes,
        aiNeurons: acc.aiNeurons + u.aiNeurons,
      }),
      { requests: 0, bandwidthBytes: 0, aiNeurons: 0 },
    );

    return c.json({ billingPeriodStart: since.toISOString(), ...totals, projects: projectUsages });
  });

interface AnalyticsRow {
  requests: number;
  bandwidth_bytes: number;
}

interface BatchAnalyticsRow extends AnalyticsRow {
  blob1: string;
}

interface TopProjectTrafficRow extends BatchAnalyticsRow {
  last_seen: string;
}

interface TopProjectTrafficEntry {
  projectId: string;
  requests: number;
  bandwidthBytes: number;
  lastSeen: string;
}

function getRequestsDataset(env: { REQUESTS_DATASET?: string; PLATFORM_ENV?: string }): string {
  if (env.REQUESTS_DATASET) {
    return env.REQUESTS_DATASET;
  }
  return env.PLATFORM_ENV === 'staging' ? 'void_requests_staging' : 'void_requests';
}

async function queryProjectUsage(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  projectId: string,
  since: Date,
): Promise<{ requests: number; bandwidthBytes: number }> {
  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const query = `
    SELECT
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM ${requestsDataset}
    WHERE blob1 = '${projectId}'
      AND timestamp >= toDateTime('${sinceStr}')
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    },
  );

  if (!response.ok) {
    return { requests: 0, bandwidthBytes: 0 };
  }

  const result = (await response.json()) as { data: AnalyticsRow[] };
  const row = result.data?.[0];
  return {
    requests: Math.round(row?.requests ?? 0),
    bandwidthBytes: Math.round(row?.bandwidth_bytes ?? 0),
  };
}

type UsageEntry = { requests: number; bandwidthBytes: number };
const ZERO_USAGE: UsageEntry = { requests: 0, bandwidthBytes: 0 };

async function queryBatchProjectUsage(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  projectIds: string[],
  since: Date,
): Promise<Map<string, UsageEntry>> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const inList = projectIds.map((id) => `'${id}'`).join(', ');
  const query = `
    SELECT
      blob1,
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM ${requestsDataset}
    WHERE blob1 IN (${inList})
      AND timestamp >= toDateTime('${sinceStr}')
    GROUP BY blob1
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    },
  );

  if (!response.ok) {
    return new Map();
  }

  const json = (await response.json()) as { data: BatchAnalyticsRow[] };
  const result = new Map<string, UsageEntry>();
  for (const row of json.data ?? []) {
    result.set(row.blob1, {
      requests: Math.round(row.requests ?? 0),
      bandwidthBytes: Math.round(row.bandwidth_bytes ?? 0),
    });
  }
  return result;
}

async function queryTopProjectTraffic(
  accountId: string,
  apiToken: string,
  requestsDataset: string,
  since: Date,
  limit: number,
): Promise<TopProjectTrafficEntry[]> {
  if (limit <= 0) {
    return [];
  }

  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);
  const query = `
    SELECT
      blob1,
      MAX(timestamp) as last_seen,
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM ${requestsDataset}
    WHERE timestamp >= toDateTime('${sinceStr}')
      AND blob2 IN ('static', 'ssr', 'isr')
      AND blob3 IN ('GET', 'HEAD')
    GROUP BY blob1
    ORDER BY requests DESC
    LIMIT ${limit}
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    },
  );

  if (!response.ok) {
    return [];
  }

  const json = (await response.json()) as { data: TopProjectTrafficRow[] };
  return (json.data ?? []).map((row) => ({
    projectId: row.blob1,
    requests: Math.round(row.requests ?? 0),
    bandwidthBytes: Math.round(row.bandwidth_bytes ?? 0),
    lastSeen: row.last_seen,
  }));
}

interface AiGatewayResponse {
  data: {
    viewer: {
      accounts: {
        aiGatewayRequests: { sum: { cost: number } }[];
      }[];
    };
  };
}

const COST_PER_NEURON = 0.000011;

async function queryProjectAiUsage(
  accountId: string,
  apiToken: string,
  projectId: string,
  since: Date,
): Promise<{ neurons: number }> {
  const query = `query {
  viewer {
    accounts(filter: { accountTag: "${accountId}" }) {
      aiGatewayRequests(
        filter: {
          gatewayId: "void"
          metadata_projectId: "${projectId}"
          datetime_geq: "${since.toISOString()}"
        }
      ) {
        sum { cost }
      }
    }
  }
}`;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    return { neurons: 0 };
  }

  const result = (await response.json()) as AiGatewayResponse;
  const requests = result.data?.viewer?.accounts?.[0]?.aiGatewayRequests;
  const cost = requests?.[0]?.sum?.cost ?? 0;
  return { neurons: Math.round(cost / COST_PER_NEURON) };
}

export {
  getRequestsDataset,
  queryProjectUsage,
  queryBatchProjectUsage,
  queryTopProjectTraffic,
  queryProjectAiUsage,
  projectUsage,
  accountUsage,
  ZERO_USAGE,
};
