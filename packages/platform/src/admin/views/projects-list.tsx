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
              <th>Name</th>
              <th>URL</th>
              <th>Owner</th>
              <th>Mode</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/admin/projects/${p.id}`}>{p.name}</a>
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
