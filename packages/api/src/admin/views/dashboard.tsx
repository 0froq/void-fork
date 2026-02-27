import type { ProjectRow } from "./projects-table";
import { ProjectsTable } from "./projects-table";
import { Layout } from "./layout";

interface DashboardProps {
  stats: {
    users: number;
    projects: number;
    deployments: number;
  };
  projects: ProjectRow[];
  siteDomain: string;
  username?: string;
}

export function DashboardPage({ stats, projects, siteDomain, username }: DashboardProps) {
  return (
    <Layout title="Dashboard" username={username}>
      <h1>Dashboard</h1>
      <div style="display: flex; gap: 12px">
        <a
          href="/admin/users"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.users}</div>
          <div>users</div>
        </a>
        <a
          href="/admin/projects"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.projects}</div>
          <div>projects</div>
        </a>
        <a
          href="/admin/deployments"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.deployments}</div>
          <div>deployments</div>
        </a>
      </div>

      <h2>Projects</h2>
      <ProjectsTable projects={projects} siteDomain={siteDomain} />
    </Layout>
  );
}
