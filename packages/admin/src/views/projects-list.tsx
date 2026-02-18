import type { Project } from "@vite-cloud/platform/types";
import { Layout } from "./layout";

export function ProjectsListPage({ projects }: { projects: Project[] }) {
  return (
    <Layout title="Projects">
      <h1>Projects</h1>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Owner</th>
              <th>Mode</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`/projects/${p.id}`}>{p.name}</a>
                </td>
                <td>{p.slug}</td>
                <td>{p.user_id}</td>
                <td>{p.mode}</td>
                <td>{new Date(p.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {projects.length === 0 && <p style="padding: 1rem; color: #6b7280">No projects found.</p>}
      </div>
    </Layout>
  );
}
