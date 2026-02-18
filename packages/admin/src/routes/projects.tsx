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
  return c.html(<ProjectsListPage projects={projects} page={page} totalPages={totalPages} />);
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
                  <td style="font-family: monospace; font-size: 0.8rem">{r.cf_id}</td>
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
                    <td style="font-family: monospace; font-size: 0.8rem">{d.id}</td>
                    <td>
                      <span class={`badge ${statusCls}`}>{d.status}</span>
                    </td>
                    <td>{d.source ?? "-"}</td>
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
