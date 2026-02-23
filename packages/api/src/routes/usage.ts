import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { getProject, getProjectsByUserId, getUser } from "../db";
import { getCurrentBillingPeriodStart } from "../tiers";

const projectUsage = new Hono<ApiEnv>()

  // Project usage for current billing period
  .get("/:id/usage", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProject(c.get("db"), projectId);
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    if (project.user_id !== c.get("userId")) {
      return c.json({ error: "forbidden" }, 403);
    }

    // Dev bypass — skip slow CF Analytics Engine API calls
    if (c.env.DEV_AUTH_BYPASS) {
      return c.json({
        projectId,
        billingPeriodStart: new Date().toISOString(),
        requests: 0,
        bandwidthBytes: 0,
        aiNeurons: 0,
      });
    }

    const user = await getUser(c.get("db"), c.get("userId"));
    const since = getCurrentBillingPeriodStart(user!.billing_cycle_start);
    const [usage, aiUsage] = await Promise.all([
      queryProjectUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, projectId, since),
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
  .get("/", async (c) => {
    const projects = await getProjectsByUserId(c.get("db"), c.get("userId"));
    if (projects.length === 0) {
      return c.json({ requests: 0, bandwidthBytes: 0, aiNeurons: 0, projects: [] });
    }

    // Dev bypass — skip slow CF Analytics Engine API calls
    if (c.env.DEV_AUTH_BYPASS) {
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

    const user = await getUser(c.get("db"), c.get("userId"));
    const since = getCurrentBillingPeriodStart(user!.billing_cycle_start);

    const projectUsages = await Promise.all(
      projects.map(async (p) => {
        const [usage, aiUsage] = await Promise.all([
          queryProjectUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, p.id, since),
          queryProjectAiUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, p.id, since),
        ]);
        return { projectId: p.id, slug: p.slug, ...usage, aiNeurons: aiUsage.neurons };
      }),
    );

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

async function queryProjectUsage(
  accountId: string,
  apiToken: string,
  projectId: string,
  since: Date,
): Promise<{ requests: number; bandwidthBytes: number }> {
  const sinceStr = since.toISOString().replace("T", " ").replace("Z", "");
  const query = `
    SELECT
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM vite_cloud_requests
    WHERE blob1 = '${projectId}'
      AND timestamp >= '${sinceStr}'
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "text/plain",
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

  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
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

export { queryProjectUsage, queryProjectAiUsage, projectUsage, accountUsage };
