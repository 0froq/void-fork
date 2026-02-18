import { Hono } from "hono";
import type { AdminEnv } from "../env";
import {
  getAllProjectsWithOwner,
  countProjects,
  getProject,
  getProjectDeployments,
  getProjectResources,
  getUser,
} from "@vite-cloud/platform/db";
import { ProjectsListPage } from "../views/projects-list";
import { Layout } from "../views/layout";

const PAGE_SIZE = 20;
const app = new Hono<AdminEnv>();

// GET /projects
app.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [projects, total] = await Promise.all([
    getAllProjectsWithOwner(c.env.DB, PAGE_SIZE, offset),
    countProjects(c.env.DB),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const siteDomain = c.env.SITE_DOMAIN ?? "vitecloud.app";
  return c.html(
    <ProjectsListPage
      projects={projects}
      page={page}
      totalPages={totalPages}
      siteDomain={siteDomain}
    />,
  );
});

// GET /projects/:id
app.get("/:id", async (c) => {
  const project = await getProject(c.env.DB, c.req.param("id"));
  if (!project) {
    return c.html("<h1>Project not found</h1>", 404);
  }
  const [deployments, resources, owner] = await Promise.all([
    getProjectDeployments(c.env.DB, project.id, 10),
    getProjectResources(c.env.DB, project.id),
    getUser(c.env.DB, project.user_id),
  ]);

  const cfAccountId = c.env.CF_ACCOUNT_ID;
  const siteDomain = c.env.SITE_DOMAIN ?? "vitecloud.app";
  const deployUrl = `https://${project.slug}.${siteDomain}`;

  return c.html(
    <Layout title={project.name}>
      <h1>{project.name}</h1>

      <div class="card mb-1">
        <table>
          <tbody>
            <tr>
              <th>ID</th>
              <td>{project.id}</td>
            </tr>
            <tr>
              <th>Slug</th>
              <td>{project.slug}</td>
            </tr>
            <tr>
              <th>URL</th>
              <td>
                <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                  {deployUrl}
                </a>
              </td>
            </tr>
            <tr>
              <th>Assets</th>
              <td>
                <a
                  href={`https://dash.cloudflare.com/${cfAccountId}/r2/default/buckets/vite-cloud-assets?prefix=${encodeURIComponent(project.id + "/")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  R2: vite-cloud-assets/{project.id}/
                </a>
              </td>
            </tr>
            <tr>
              <th>Owner</th>
              <td>{owner ? <a href={`/users/${owner.id}`}>{owner.login}</a> : project.user_id}</td>
            </tr>
            <tr>
              <th>Mode</th>
              <td>{project.mode}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{project.created_at}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card mb-1">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Resources ({resources.length})</h2>
        {resources.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Binding</th>
                <th>CF ID</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span class="badge badge-blue">{r.type}</span>
                  </td>
                  <td>{r.binding_name}</td>
                  <td style="font-family: monospace; font-size: 0.8rem">
                    {cfAccountId && (r.type === "d1" || r.type === "kv" || r.type === "r2") ? (
                      <a
                        href={
                          r.type === "d1"
                            ? `https://dash.cloudflare.com/${cfAccountId}/workers/d1/databases/${r.cf_id}/metrics`
                            : r.type === "kv"
                              ? `https://dash.cloudflare.com/${cfAccountId}/workers/kv/namespaces/${r.cf_id}/metrics`
                              : `https://dash.cloudflare.com/${cfAccountId}/r2/default/buckets/${r.cf_id}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {r.cf_id}
                      </a>
                    ) : (
                      r.cf_id
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style="color: #6b7280">No resources provisioned.</p>
        )}
      </div>

      <div class="card">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">
          Recent Deployments ({deployments.length})
        </h2>
        {deployments.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Source</th>
                <th>Error</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => {
                const statusCls =
                  d.status === "live"
                    ? "badge-green"
                    : d.status === "failed"
                      ? "badge-red"
                      : "badge-gray";
                return (
                  <tr key={d.id}>
                    <td style="font-family: monospace; font-size: 0.8rem">
                      <a href={`/deployments/${d.id}`}>{d.id}</a>
                    </td>
                    <td>
                      <span class={`badge ${statusCls}`}>{d.status}</span>
                    </td>
                    <td>{d.source ?? "-"}</td>
                    <td style="color: #dc2626; font-size: 0.8rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                      {d.error_message ? d.error_message.slice(0, 60) : "-"}
                    </td>
                    <td>{new Date(d.created_at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p style="color: #6b7280">No deployments.</p>
        )}
      </div>
    </Layout>,
  );
});

export default app;
