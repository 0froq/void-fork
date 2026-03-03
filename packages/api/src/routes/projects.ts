import { Hono } from "hono";
import type { ApiEnv } from "../env";
import {
  createProject,
  getProject,
  getProjectBySlug,
  getProjectsByUserId,
  getProjectDeployments,
  getProjectResources,
  getDomainsByProjectIds,
} from "../db";
import { queryD1 } from "../migrations/remote-runner";

const app = new Hono<ApiEnv>()

  // List all projects for the current user
  .get("/", async (c) => {
    const userId = c.get("userId");
    const projects = await getProjectsByUserId(c.get("db"), userId);

    // Batch-fetch domains for all projects in a single query
    const projectIds = projects.map((p) => p.id);
    const domainMap =
      projectIds.length > 0 ? await getDomainsByProjectIds(c.get("db"), projectIds) : new Map();

    const projectsWithDomains = projects.map((p) => {
      const pDomains = domainMap.get(p.id);
      const domain =
        pDomains?.find((d: { status: string }) => d.status === "active") ?? pDomains?.[0];
      return { ...p, custom_domain: domain?.hostname ?? null };
    });

    return c.json(projectsWithDomains);
  })

  // Create a new project
  .post("/", async (c) => {
    const body = await c.req.json<{ slug: string }>();

    if (!body.slug) {
      return c.json({ error: "slug is required" }, 400);
    }

    // Validate slug format: lowercase alphanumeric + dashes
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug) && body.slug.length > 1) {
      return c.json({ error: "slug must be lowercase alphanumeric with dashes" }, 400);
    }

    // Check for slug uniqueness
    const existing = await getProjectBySlug(c.get("db"), body.slug);
    if (existing) {
      return c.json({ error: "slug already taken" }, 409);
    }

    const userId = c.get("userId");
    try {
      const project = await createProject(c.get("db"), userId, body.slug);
      return c.json(project, 201);
    } catch (err) {
      // Unique constraint violation — slug was taken between check and insert
      if (
        err instanceof Error &&
        err.message.includes("duplicate key value violates unique constraint")
      ) {
        return c.json({ error: "slug already taken" }, 409);
      }
      throw err;
    }
  })

  // Get project by ID
  .get("/:id", async (c) => {
    const project = await getProject(c.get("db"), c.req.param("id"));
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    if (project.user_id !== c.get("userId")) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json(project);
  })

  // List deployments for a project
  .get("/:id/deployments", async (c) => {
    const project = await getProject(c.get("db"), c.req.param("id"));
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }

    if (project.user_id !== c.get("userId")) {
      return c.json({ error: "forbidden" }, 403);
    }

    const deployments = await getProjectDeployments(c.get("db"), project.id);
    return c.json(deployments);
  })

  // Get migration status for a project
  .get("/:id/migrations", async (c) => {
    const project = await getProject(c.get("db"), c.req.param("id"));
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }

    if (project.user_id !== c.get("userId")) {
      return c.json({ error: "forbidden" }, 403);
    }

    const resources = await getProjectResources(c.get("db"), project.id);
    const d1Resource = resources.find((r) => r.type === "d1");
    if (!d1Resource) {
      return c.json({ applied: [] });
    }

    try {
      const result = await queryD1(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, d1Resource.cf_id, {
        sql: "SELECT name, applied_at FROM _migrations ORDER BY name",
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
  .get("/:id/resources", async (c) => {
    const project = await getProject(c.get("db"), c.req.param("id"));
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    if (project.user_id !== c.get("userId")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const resources = await getProjectResources(c.get("db"), project.id);
    return c.json(resources);
  })

  // Fetch logs for a project
  .get("/:id/logs", async (c) => {
    const project = await getProject(c.get("db"), c.req.param("id"));
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    if (project.user_id !== c.get("userId")) {
      return c.json({ error: "forbidden" }, 403);
    }

    const since = c.req.query("since") ?? "1h";
    const sinceMs = parseDuration(since);
    if (sinceMs === null) {
      return c.json({ error: "invalid since parameter, use format like 15m, 2h, 3d" }, 400);
    }

    const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10) || 200, 500);
    const workerName = `user-${project.slug}`;
    const sinceStr = new Date(Date.now() - sinceMs).toISOString().replace("T", " ").slice(0, 19);
    const dataset = c.env.LOGS_DATASET ?? "void_logs";

    const query = `
      SELECT
        blob1 as outcome,
        blob2 as logData,
        blob3 as exceptionData,
        blob4 as url,
        blob5 as method,
        blob6 as statusCode,
        double1 as ts,
        timestamp
      FROM ${dataset}
      WHERE index1 = '${workerName}'
        AND timestamp >= toDateTime('${sinceStr}')
      ORDER BY double1 ASC
      LIMIT ${limit}
    `;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
          "Content-Type": "text/plain",
        },
        body: query,
      },
    );

    if (!response.ok) {
      return c.json({ error: "log query failed" }, 502);
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

    const data = (result.data ?? []).map((row) => ({
      timestamp: row.ts,
      outcome: row.outcome,
      logs: tryParse(row.logData),
      exceptions: tryParse(row.exceptionData),
      url: row.url,
      method: row.method,
      status: row.statusCode,
    }));

    return c.json({ data });
  });

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = value * multipliers[unit];
  if (ms > 7 * 86_400_000) return null; // cap at 7d
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
