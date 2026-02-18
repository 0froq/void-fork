import { Hono } from "hono";
import type { AdminEnv } from "../env";
import {
  getAllDeploymentsWithProject,
  countDeployments,
  getDeployment,
  getProject,
} from "@vite-cloud/platform/db";
import { DeploymentsListPage } from "../views/deployments-list";
import { Layout } from "../views/layout";

const PAGE_SIZE = 20;
const app = new Hono<AdminEnv>();

// GET /deployments
app.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [deployments, total] = await Promise.all([
    getAllDeploymentsWithProject(c.env.DB, PAGE_SIZE, offset),
    countDeployments(c.env.DB),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return c.html(
    <DeploymentsListPage deployments={deployments} page={page} totalPages={totalPages} />,
  );
});

// GET /deployments/:id
app.get("/:id", async (c) => {
  const deployment = await getDeployment(c.env.DB, c.req.param("id"));
  if (!deployment) {
    return c.html("<h1>Deployment not found</h1>", 404);
  }
  const project = await getProject(c.env.DB, deployment.project_id);

  const statusCls =
    deployment.status === "live"
      ? "badge-green"
      : deployment.status === "failed"
        ? "badge-red"
        : "badge-gray";

  return c.html(
    <Layout title={`Deployment ${deployment.id}`}>
      <h1>Deployment {deployment.id}</h1>

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
                  <a href={`/projects/${project.id}`}>
                    {project.name} ({project.slug})
                  </a>
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
    </Layout>,
  );
});

export default app;
