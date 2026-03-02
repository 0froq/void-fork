import { Hono } from "hono";
import type { Handler } from "hono";
import { sql } from "drizzle-orm";
import type { ApiEnv } from "../../env";
import type { Db } from "../../db";
import { getSystemStats, getAllProjectsWithOwner, getAllDeploymentsWithProject } from "../../db";
import { DashboardPage } from "../views/dashboard";
import { SITE_DOMAIN } from "../../constants";

/** Derive the base cloud domain from the API request hostname.
 *  api.void.cloud → void.cloud, api.staging.void.cloud → staging.void.cloud */
function cloudDomainFromHost(host: string): string {
  return host.replace(/^api\./, "");
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthResult {
  checks: HealthCheck[];
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
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkDb(db: Db): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { name: "db", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      name: "db",
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function mockHealthResult(): HealthResult {
  const names = ["api", "proxy", "dashboard", "dispatch", "db"];
  return {
    checks: names.map((name) => ({ name, ok: true, latencyMs: 0 })),
    allOk: true,
  };
}

export const adminSystem = new Hono<ApiEnv>();

adminSystem.get("/health", async (c) => {
  if (c.env.DEV_AUTH_BYPASS) {
    return c.json(mockHealthResult());
  }

  const cloudDomain = cloudDomainFromHost(new URL(c.req.url).hostname);
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;

  // API check is implicit — we're serving this request, so the API is up.
  const apiCheck: HealthCheck = { name: "api", ok: true, latencyMs: 0 };

  const checks = [
    apiCheck,
    ...(await Promise.all([
      checkUrl("proxy", `https://proxy.${cloudDomain}/health`),
      checkUrl("dashboard", `https://dash.${cloudDomain}/login`),
      checkUrl("dispatch", `https://test.${siteDomain}/health`, {
        "X-Health-Check": "void-admin",
      }),
      checkDb(c.get("db")),
    ])),
  ];

  return c.json({ checks, allOk: checks.every((ch) => ch.ok) } satisfies HealthResult);
});

export const dashboardHandler: Handler<ApiEnv> = async (c) => {
  const [stats, projects, deployments] = await Promise.all([
    getSystemStats(c.get("db")),
    getAllProjectsWithOwner(c.get("db"), 5, 0),
    getAllDeploymentsWithProject(c.get("db"), 5, 0),
  ]);
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
  return c.html(
    <DashboardPage
      stats={stats}
      projects={projects}
      deployments={deployments}
      siteDomain={siteDomain}
      username={c.get("userLogin")}
    />,
  );
};
