import type { Project } from "@vite-cloud/platform/types";
import { Layout } from "./layout";

interface DashboardProps {
  stats: {
    users: number;
    projects: number;
    deployments: number;
  };
  projects: (Project & { owner_login: string | null })[];
}

export function DashboardPage({ stats, projects }: DashboardProps) {
  return (
    <Layout title="Dashboard">
      <h1>Dashboard</h1>
      <div class="grid">
        <a href="/users" style="text-decoration: none; color: inherit">
          <div class="card stat">
            <div class="stat-value">{stats.users}</div>
            <div class="stat-label">Users</div>
          </div>
        </a>
        <a href="/projects" style="text-decoration: none; color: inherit">
          <div class="card stat">
            <div class="stat-value">{stats.projects}</div>
            <div class="stat-label">Projects</div>
          </div>
        </a>
        <a href="/deployments" style="text-decoration: none; color: inherit">
          <div class="card stat">
            <div class="stat-value">{stats.deployments}</div>
            <div class="stat-label">Deployments</div>
          </div>
        </a>
      </div>

      <div class="card" style="margin-top: 1.5rem">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Projects</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Owner</th>
              <th>Owner ID</th>
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
                <td>{p.owner_login ? <a href={`/users/${p.user_id}`}>{p.owner_login}</a> : "-"}</td>
                <td style="font-family: monospace; font-size: 0.8rem">{p.user_id}</td>
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
