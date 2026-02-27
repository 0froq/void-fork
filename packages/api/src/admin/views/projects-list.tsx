import type { Project } from "../../types";
import { Layout } from "./layout";
import { Pagination } from "./pagination";

export function ProjectsListPage({
  projects,
  page,
  totalPages,
  siteDomain,
  username,
}: {
  projects: (Project & { owner_login: string | null })[];
  page: number;
  totalPages: number;
  siteDomain: string;
  username?: string;
}) {
  return (
    <Layout title="Projects" username={username}>
      <h1>Projects</h1>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>URL</th>
              <th>Owner</th>
              <th>Mode</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/admin/projects/${p.id}`}>{p.slug}</a>
                </td>
                <td>
                  <a
                    href={`https://${p.slug}.${siteDomain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {p.slug}.{siteDomain}
                  </a>
                </td>
                <td>
                  {p.owner_login ? <a href={`/admin/users/${p.user_id}`}>{p.owner_login}</a> : "-"}
                </td>
                <td>{p.mode}</td>
                <td>{new Date(p.created_at).toLocaleDateString()}</td>
                <td>
                  <form
                    method="post"
                    action={`/admin/projects/${p.id}/delete`}
                    style="display: inline"
                    onsubmit={`return confirm('Delete project "${p.slug}"?')`}
                  >
                    <button
                      class="btn btn-danger"
                      type="submit"
                      style="font-size: 0.75rem; padding: 0.2rem 0.5rem"
                    >
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {projects.length === 0 && <p style="padding: 1rem; color: #6b7280">No projects found.</p>}
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/projects" />
      </div>
    </Layout>
  );
}
