import { Hono } from "hono";
import type { PlatformEnv } from "../../env";
import {
  getAllDeploymentsWithProject,
  countDeployments,
  getDeployment,
  getProject,
} from "../../db";
import type { DeployManifest } from "../../types";
import { DeploymentsListPage } from "../views/deployments-list";
import { Layout } from "../views/layout";

const PAGE_SIZE = 20;
const app = new Hono<PlatformEnv>();

// GET /deployments
app.get("/", async (c) => {
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

  const statusCls =
    deployment.status === "live"
      ? "badge-green"
      : deployment.status === "failed"
        ? "badge-red"
        : "badge-gray";

  let manifest: DeployManifest | null = null;
  try {
    if (deployment.manifest) {
      manifest = JSON.parse(deployment.manifest) as DeployManifest;
    }
  } catch {
    // invalid JSON — skip manifest display
  }

  const mode = manifest
    ? (manifest.static ?? (manifest.framework ? "framework" : manifest.ssr ? "ssr" : "fullstack"))
    : null;

  return c.html(
    <Layout title={`Deployment ${deployment.id}`} username={c.get("userLogin")}>
      <h1>Deployment {deployment.id}</h1>

      {deployment.status === "failed" && deployment.error_message && (
        <div
          class="card mb-1"
          style="background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b"
        >
          <h2 style="font-size: 1.125rem; margin-bottom: 0.5rem">Error</h2>
          <pre style="margin: 0; white-space: pre-wrap; font-size: 0.85rem">
            {deployment.error_message}
          </pre>
        </div>
      )}

      <div class="card mb-1">
        <table>
          <tbody>
            <tr>
              <th>ID</th>
              <td style="font-family: monospace; font-size: 0.8rem">{deployment.id}</td>
            </tr>
            <tr>
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
              <td>
                <span class={`badge ${statusCls}`}>{deployment.status}</span>
              </td>
            </tr>
            <tr>
              <th>Source</th>
              <td>{deployment.source ?? "-"}</td>
            </tr>
            <tr>
              <th>Commit</th>
              <td style="font-family: monospace; font-size: 0.8rem">{deployment.commit ?? "-"}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{deployment.created_at}</td>
            </tr>
            <tr>
              <th>Deployed</th>
              <td>{deployment.deployed_at ?? "-"}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {manifest && (
        <div class="card mb-1">
          <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Manifest</h2>
          <table>
            <tbody>
              {mode && (
                <tr>
                  <th>Mode</th>
                  <td>{mode}</td>
                </tr>
              )}
              {manifest.bindings &&
                Object.entries(manifest.bindings).map(([type, value]) =>
                  Array.isArray(value) && value.length > 0 ? (
                    <tr key={type}>
                      <th>{type.toUpperCase()}</th>
                      <td>
                        {value.map((n: string) => (
                          <span key={n} class="badge badge-blue" style="margin-right: 0.25rem">
                            {n}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ) : value === true ? (
                    <tr key={type}>
                      <th>{type.toUpperCase()}</th>
                      <td>
                        <span class="badge badge-blue">enabled</span>
                      </td>
                    </tr>
                  ) : null,
                )}
              {manifest.migrations && manifest.migrations.length > 0 && (
                <tr>
                  <th>Migrations</th>
                  <td>
                    {manifest.migrations.map((m) => (
                      <span
                        key={m.name}
                        class={`badge ${m.destructive ? "badge-red" : "badge-gray"}`}
                        style="margin-right: 0.25rem"
                      >
                        {m.name}
                        {m.destructive ? " (destructive)" : ""}
                      </span>
                    ))}
                  </td>
                </tr>
              )}
              {manifest.schedules && manifest.schedules.length > 0 && (
                <tr>
                  <th>Schedules</th>
                  <td>
                    {manifest.schedules.map((s) => (
                      <span key={s.name} class="badge badge-gray" style="margin-right: 0.25rem">
                        {s.name}: {s.cron}
                      </span>
                    ))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {deployment.manifest && (
        <div class="card">
          <details>
            <summary style="cursor: pointer; font-weight: 600; font-size: 1.125rem">
              Raw Manifest
            </summary>
            <pre style="margin-top: 0.5rem; font-size: 0.8rem; overflow-x: auto">
              {JSON.stringify(JSON.parse(deployment.manifest), null, 2)}
            </pre>
          </details>
        </div>
      )}
    </Layout>,
  );
});

export default app;
