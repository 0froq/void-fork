import { Hono } from "hono";
import type { ApiEnv } from "../../env";
import {
  getAllDeploymentsWithProject,
  countDeployments,
  getDeployment,
  getProject,
} from "../../db";
import type { DeployManifest } from "../../types";
import {
  queryWorkerLogs,
  createTailSession,
  deleteTailSession,
} from "../../provisioning/cloudflare-api";
import { DeploymentsListPage } from "../views/deployments-list";
import { DeploymentLogs } from "../views/deployment-logs";
import { Layout } from "../views/layout";
import { formatDateTime } from "../views/format";

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

// GET /deployments
app.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const tz = (c.req.raw.cf?.timezone as string | undefined) ?? undefined;
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

  const mode = manifest
    ? manifest.framework
      ? "framework"
      : manifest.ssr
        ? "ssr"
        : manifest.assetConfig
          ? "static"
          : "void"
    : null;

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
              style={
                deployment.status === "live"
                  ? "color: green"
                  : deployment.status === "failed"
                    ? "color: red"
                    : undefined
              }
            >
              {deployment.status}
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
            {mode ? (
              <>
                <th>Mode</th>
                <td>{mode}</td>
              </>
            ) : (
              <>
                <th />
                <td />
              </>
            )}
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
                        {manifest.migrations && manifest.migrations.length > 0 && (
                          <tr>
                            <th>Migrations</th>
                            <td>
                              {manifest.migrations.map((m, i) => (
                                <span key={m.name}>
                                  {i > 0 && ", "}
                                  {m.name}
                                  {m.destructive && " (destructive)"}
                                </span>
                              ))}
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

      {deployment.status === "live" && project && (
        <DeploymentLogs
          deploymentId={deployment.id}
          workerName={`user-${project.slug}`}
          since={c.req.query("since") ?? "1h"}
          level={c.req.query("level") ?? "all"}
        />
      )}
    </Layout>,
  );
});

// GET /deployments/:id/logs — query historical logs via CF Observability API
app.get("/:id/logs", async (c) => {
  const deployment = await getDeployment(c.get("db"), c.req.param("id"));
  if (!deployment) {
    return c.json({ error: "deployment not found" }, 404);
  }
  const project = await getProject(c.get("db"), deployment.project_id);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  const workerName = `user-${project.slug}`;
  const since = c.req.query("since") ?? "1h";
  const sinceMs = parseSince(since);
  const level = c.req.query("level") ?? "all";
  const outcome = c.req.query("outcome") ?? "all";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

  try {
    const result = await queryWorkerLogs(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, workerName, {
      sinceMs,
      level,
      outcome,
      limit,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: "log query failed", details: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

const DEFAULT_DISPATCH_NAMESPACE = "void-users";

// POST /deployments/:id/tail — create a real-time tail session
app.post("/:id/tail", async (c) => {
  const deployment = await getDeployment(c.get("db"), c.req.param("id"));
  if (!deployment) {
    return c.json({ error: "deployment not found" }, 404);
  }
  const project = await getProject(c.get("db"), deployment.project_id);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  const workerName = `user-${project.slug}`;
  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;

  try {
    const session = await createTailSession(
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
      dispatchNamespace,
      workerName,
    );
    return c.json({ url: session.url, id: session.id });
  } catch (err) {
    return c.json(
      { error: "tail session failed", details: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

// DELETE /deployments/:id/tail/:tailId — clean up a tail session
app.delete("/:id/tail/:tailId", async (c) => {
  const deployment = await getDeployment(c.get("db"), c.req.param("id"));
  if (!deployment) {
    return c.json({ error: "deployment not found" }, 404);
  }
  const project = await getProject(c.get("db"), deployment.project_id);
  if (!project) {
    return c.json({ error: "project not found" }, 404);
  }

  const workerName = `user-${project.slug}`;
  const dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;

  try {
    await deleteTailSession(
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
      dispatchNamespace,
      workerName,
      c.req.param("tailId"),
    );
    return c.json({ ok: true });
  } catch (err) {
    return c.json(
      { error: "tail cleanup failed", details: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

function parseSince(since: string): number {
  const now = Date.now();
  const units: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };
  return now - (units[since] ?? units["1h"]);
}

export default app;
