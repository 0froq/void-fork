import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import { getProject, getProjectsByUserId } from "../db";

const app = new Hono<PlatformEnv>();

// Project usage for current billing period
app.get("/:id/usage", async (c) => {
  const projectId = c.req.param("id");
  const project = await getProject(c.env.DB, projectId);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }
  if (project.user_id !== c.get("userId")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const usage = await queryProjectUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, projectId);

  return c.json({ projectId, ...usage });
});

// Aggregate usage across all user's projects
app.get("/", async (c) => {
  const projects = await getProjectsByUserId(c.env.DB, c.get("userId"));
  if (projects.length === 0) {
    return c.json({ requests: 0, bandwidthBytes: 0, projects: [] });
  }

  const projectUsages = await Promise.all(
    projects.map(async (p) => {
      const usage = await queryProjectUsage(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, p.id);
      return { projectId: p.id, slug: p.slug, ...usage };
    }),
  );

  const totals = projectUsages.reduce(
    (acc, u) => ({
      requests: acc.requests + u.requests,
      bandwidthBytes: acc.bandwidthBytes + u.bandwidthBytes,
    }),
    { requests: 0, bandwidthBytes: 0 },
  );

  return c.json({ ...totals, projects: projectUsages });
});

interface AnalyticsRow {
  requests: number;
  bandwidth_bytes: number;
}

async function queryProjectUsage(
  accountId: string,
  apiToken: string,
  projectId: string,
): Promise<{ requests: number; bandwidthBytes: number }> {
  // Query Analytics Engine SQL API for the current billing period (last 30 days)
  const query = `
    SELECT
      SUM(_sample_interval * double1) as requests,
      SUM(_sample_interval * double2) as bandwidth_bytes
    FROM vite_cloud_requests
    WHERE blob1 = '${projectId}'
      AND timestamp >= NOW() - INTERVAL '30' DAY
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

export { queryProjectUsage };
export default app;
