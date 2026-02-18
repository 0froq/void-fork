import { Layout } from "./layout";

interface DashboardProps {
  stats: {
    users: number;
    projects: number;
    deployments: number;
  };
}

export function DashboardPage({ stats }: DashboardProps) {
  return (
    <Layout title="Dashboard">
      <h1>Dashboard</h1>
      <div class="grid">
        <div class="card stat">
          <div class="stat-value">{stats.users}</div>
          <div class="stat-label">Users</div>
        </div>
        <div class="card stat">
          <div class="stat-value">{stats.projects}</div>
          <div class="stat-label">Projects</div>
        </div>
        <div class="card stat">
          <div class="stat-value">{stats.deployments}</div>
          <div class="stat-label">Deployments</div>
        </div>
      </div>
    </Layout>
  );
}
