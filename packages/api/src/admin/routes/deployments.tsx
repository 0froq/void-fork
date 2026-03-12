import { Hono } from "hono";
import { type ApiEnv, isDevBypass } from "../../env";
import {
  getAllDeploymentsWithProject,
  countDeployments,
  searchDeployments,
  getDeployment,
  getProject,
} from "../../db";
import type { DeployManifest } from "../../types";
import { DeploymentsListPage } from "../views/deployments-list";
import { DeploymentLogs } from "../views/deployment-logs";
import { displayStatus } from "../views/deployment-table";
import { Layout } from "../views/layout";
import { formatDateTime } from "../views/format";

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

// GET /deployments
app.get("/", async (c) => {
  const search = c.req.query("search");
  const tz = (c.req.raw.cf?.timezone as string | undefined) ?? undefined;
  if (search) {
    const deployments = await searchDeployments(c.get("db"), search);
    return c.html(
      <DeploymentsListPage
        deployments={deployments}
        search={search}
        username={c.get("userLogin")}
        tz={tz}
      />,
    );
  }
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [deployments, total] = await Promise.all([
    getAllDeploymentsWithProject(c.get("db"), PAGE_SIZE, offset),
    countDeployments(c.get("db")),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return c.html(
    <DeploymentsListPage
      deployments={deployments}
      page={page}
      totalPages={totalPages}
      username={c.get("userLogin")}
      tz={tz}
    />,
  );
});

// GET /deployments/:id
app.get("/:id", async (c) => {
  const deployment = await getDeployment(c.get("db"), c.req.param("id"));
  if (!deployment) {
    return c.html("<h1>Deployment not found</h1>", 404);
  }
  const project = await getProject(c.get("db"), deployment.project_id);
  const tz = (c.req.raw.cf?.timezone as string | undefined) ?? undefined;

  let manifest: DeployManifest | null = null;
  try {
    if (deployment.manifest) {
      manifest = JSON.parse(deployment.manifest) as DeployManifest;
    }
  } catch {
    // invalid JSON — skip manifest display
  }

  return c.html(
    <Layout title={`Deployment ${deployment.id}`} username={c.get("userLogin")}>
      <h1>Deployment {deployment.id}</h1>

      {deployment.status === "failed" && deployment.error_message && (
        <>
          <h2>Error</h2>
          <pre>{deployment.error_message}</pre>
          <p>
            <button type="button" class="copy-btn" data-copy={deployment.error_message}>
              Copy error
            </button>
          </p>
        </>
      )}

      <table>
        <tbody>
          <tr>
            <th>ID</th>
            <td>{deployment.id}</td>
            <th>Project</th>
            <td>
              {project ? (
                <a href={`/admin/projects/${project.id}`}>{project.slug}</a>
              ) : (
                deployment.project_id
              )}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td
              style={(() => {
                const s = displayStatus(deployment, project?.active_deployment_id);
                if (s === "live") return "color: #16a34a; font-weight: 600";
                if (s === "retained") return "color: #16a34a";
                if (s === "evicted") return "color: #888";
                if (s === "failed") return "color: #dc2626";
                return undefined;
              })()}
            >
              {displayStatus(deployment, project?.active_deployment_id)}
            </td>
            <th>Source</th>
            <td>{deployment.source ?? "-"}</td>
          </tr>
          <tr>
            <th>Commit</th>
            <td>{deployment.commit ?? "-"}</td>
            <th>Created</th>
            <td>{formatDateTime(deployment.created_at, tz)}</td>
          </tr>
          <tr>
            <th>Deployed</th>
            <td>{deployment.deployed_at ? formatDateTime(deployment.deployed_at, tz) : "-"}</td>
            <th>Type</th>
            <td>{project?.type ?? "-"}</td>
          </tr>
          {manifest && (
            <tr>
              <td colspan={4} style="padding: 0">
                <details>
                  <summary style="padding: 8px; cursor: pointer; font-weight: 600">
                    Manifest
                  </summary>
                  <div style="padding: 0 8px 8px">
                    <table style="margin: 0">
                      <tbody>
                        {manifest.bindings &&
                          Object.entries(manifest.bindings).map(([type, value]) =>
                            Array.isArray(value) && value.length > 0 ? (
                              <tr key={type}>
                                <th>{type.toUpperCase()}</th>
                                <td>
                                  {value.map((n: string, i: number) => (
                                    <span key={n}>
                                      {i > 0 && ", "}
                                      <code>{n}</code>
                                    </span>
                                  ))}
                                </td>
                              </tr>
                            ) : value === true ? (
                              <tr key={type}>
                                <th>{type.toUpperCase()}</th>
                                <td>enabled</td>
                              </tr>
                            ) : null,
                          )}
                        {manifest.migrations && (
                          <tr>
                            <th>Migrations</th>
                            <td>
                              {manifest.migrations.dialect} — {manifest.migrations.pending} pending
                            </td>
                          </tr>
                        )}
                        {manifest.schedules && manifest.schedules.length > 0 && (
                          <tr>
                            <th>Schedules</th>
                            <td>
                              {manifest.schedules.map((s, i) => (
                                <span key={s.name}>
                                  {i > 0 && ", "}
                                  {s.name}: {s.cron}
                                </span>
                              ))}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {deployment.manifest && (
                      <details style="margin-top: 8px">
                        <summary style="cursor: pointer; font-size: 0.85rem">Raw JSON</summary>
                        <pre style="margin-top: 8px; font-size: 0.8rem">
                          {JSON.stringify(JSON.parse(deployment.manifest), null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </details>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {deployment.status === "live" && project && <DeploymentLogs deploymentId={deployment.id} />}
    </Layout>,
  );
});

// GET /deployments/:id/logs — query historical logs via Analytics Engine
app.get("/:id/logs", async (c) => {
  const deployment = await getDeployment(c.get("db"), c.req.param("id"));
  if (!deployment) {
    return c.json({ error: "deployment not found" }, 404);
  }
  const project = await getProject(c.get("db"), deployment.project_id);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  if (isDevBypass(c.env)) {
    return c.json({ data: mockLogData() });
  }

  const workerName = `user-${project.slug}`;
  const since = c.req.query("since") ?? "1h";
  const sinceMs = parseSince(since);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

  const sinceStr = new Date(sinceMs).toISOString().replace("T", " ").slice(0, 19);
  const dataset = c.env.LOGS_DATASET ?? "void_logs";
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
      AND timestamp >= toDateTime('${sinceStr}')
      AND blob7 = '${deployment.id}'
    ORDER BY timestamp DESC
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
    const body = await response.text();
    return c.json({ error: "log query failed", status: response.status, detail: body, query }, 502);
  }

  const result = (await response.json()) as { data: LogRow[] };
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

interface LogRow {
  outcome: string;
  logData: string;
  exceptionData: string;
  url: string;
  method: string;
  statusCode: string;
  ts: number;
}

function tryParse(json: string): unknown[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function mockLogData() {
  const now = Date.now();
  return [
    {
      timestamp: now - 1000,
      outcome: "ok",
      logs: [
        { level: "info", message: "Incoming request: GET /api/users" },
        { level: "debug", message: "Cache HIT for key: users:list:page=1" },
      ],
      exceptions: [],
      url: "/api/users",
      method: "GET",
      status: "200",
    },
    {
      timestamp: now - 5000,
      outcome: "ok",
      logs: [{ level: "log", message: "POST /api/auth/login — user authenticated successfully" }],
      exceptions: [],
      url: "/api/auth/login",
      method: "POST",
      status: "200",
    },
    {
      timestamp: now - 12000,
      outcome: "exception",
      logs: [
        {
          level: "error",
          message:
            'TypeError: Cannot read properties of undefined (reading "id")\n    at getUser (src/handlers/users.ts:42:18)\n    at handleRequest (src/index.ts:15:3)',
        },
      ],
      exceptions: [
        { name: "TypeError", message: 'Cannot read properties of undefined (reading "id")' },
      ],
      url: "/api/users/999",
      method: "GET",
      status: "500",
    },
    {
      timestamp: now - 30000,
      outcome: "ok",
      logs: [
        {
          level: "warn",
          message: "Rate limit approaching: 85/100 requests in current window for IP 192.168.1.42",
        },
      ],
      exceptions: [],
      url: "/api/data/export",
      method: "GET",
      status: "200",
    },
    {
      timestamp: now - 45000,
      outcome: "ok",
      logs: [],
      exceptions: [],
      url: "/health",
      method: "GET",
      status: "204",
    },
    {
      timestamp: now - 60000,
      outcome: "ok",
      logs: [
        {
          level: "info",
          message:
            "D1 query executed in 12ms: SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC LIMIT 20",
        },
        { level: "info", message: "Returning 20 posts" },
      ],
      exceptions: [],
      url: "/api/posts",
      method: "GET",
      status: "200",
    },
    {
      timestamp: now - 90000,
      outcome: "canceled",
      logs: [{ level: "warn", message: "Request canceled by client before completion" }],
      exceptions: [],
      url: "/api/reports/generate",
      method: "POST",
      status: "499",
    },
  ];
}

function parseSince(since: string): number {
  const now = Date.now();
  const units: Record<string, number> = {
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };
  return now - (units[since] ?? units["1h"]);
}

export default app;
