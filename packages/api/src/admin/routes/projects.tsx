import { Hono } from "hono";
import type { ApiEnv } from "../../env";
import {
  getAllProjectsWithOwner,
  countProjects,
  getProject,
  getProjectDeployments,
  getProjectResources,
  getUser,
  getDomainsByProjectId,
  deleteProjectCascade,
} from "../../db";
import { cleanupProjectResources } from "../../provisioning/cleanup";
import { ProjectsListPage } from "../views/projects-list";
import { Layout } from "../views/layout";
import { SITE_DOMAIN } from "../../constants";

const PAGE_SIZE = 20;
const app = new Hono<ApiEnv>();

// GET /projects
app.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [projects, total] = await Promise.all([
    getAllProjectsWithOwner(c.get("db"), PAGE_SIZE, offset),
    countProjects(c.get("db")),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
  return c.html(
    <ProjectsListPage
      projects={projects}
      page={page}
      totalPages={totalPages}
      siteDomain={siteDomain}
      username={c.get("userLogin")}
    />,
  );
});

// GET /projects/:id
app.get("/:id", async (c) => {
  const project = await getProject(c.get("db"), c.req.param("id"));
  if (!project) {
    return c.html("<h1>Project not found</h1>", 404);
  }
  const [deployments, resources, owner, domains] = await Promise.all([
    getProjectDeployments(c.get("db"), project.id, 10),
    getProjectResources(c.get("db"), project.id),
    getUser(c.get("db"), project.user_id),
    getDomainsByProjectId(c.get("db"), project.id),
  ]);

  const cfAccountId = c.env.CF_ACCOUNT_ID;
  const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
  const deployUrl = `https://${project.slug}.${siteDomain}`;

  return c.html(
    <Layout title={project.slug} username={c.get("userLogin")}>
      <h1>{project.slug}</h1>

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
              <th>Custom Domain</th>
              <td>
                {domains.length > 0 ? (
                  domains.map((d) => (
                    <span key={d.id}>
                      <a href={`https://${d.hostname}`} target="_blank" rel="noopener noreferrer">
                        {d.hostname}
                      </a>{" "}
                      <span class={`badge ${d.status === "active" ? "badge-green" : "badge-gray"}`}>
                        {d.status}
                      </span>
                    </span>
                  ))
                ) : (
                  <span style="color: #6b7280">None</span>
                )}
              </td>
            </tr>
            <tr>
              <th>Assets</th>
              <td>
                <a
                  href={`https://dash.cloudflare.com/${cfAccountId}/r2/default/buckets/void-assets?prefix=${encodeURIComponent(project.id + "/")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  R2: void-assets/{project.id}/
                </a>
              </td>
            </tr>
            <tr>
              <th>Owner</th>
              <td>
                {owner ? <a href={`/admin/users/${owner.id}`}>{owner.login}</a> : project.user_id}
              </td>
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

      <div class="card mb-1">
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
                      <a href={`/admin/deployments/${d.id}`}>{d.id}</a>
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

      <div class="card" style="border: 1px solid #dc2626">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem; color: #dc2626">Danger Zone</h2>
        <form
          method="post"
          action={`/admin/projects/${project.id}/delete`}
          onsubmit="return confirm('Permanently delete project &quot;' + this.dataset.slug + '&quot; and all its resources? This cannot be undone.')"
          data-slug={project.slug}
        >
          <button class="btn btn-danger" type="submit">
            Delete Project
          </button>
        </form>
      </div>
    </Layout>,
  );
});

// POST /projects/:id/delete
app.post("/:id/delete", async (c) => {
  const project = await getProject(c.get("db"), c.req.param("id"));
  if (!project) {
    return c.html("<h1>Project not found</h1>", 404);
  }
  await cleanupProjectResources(c, project.id, project);
  await deleteProjectCascade(c.get("db"), project.id);
  return c.redirect("/admin/projects");
});

export default app;
