import type { ProjectRow } from "./projects-table";
import { ProjectsTable } from "./projects-table";
import { Layout } from "./layout";
import { Pagination } from "./pagination";

export function ProjectsListPage({
  projects,
  page,
  totalPages,
  siteDomain,
  username,
}: {
  projects: ProjectRow[];
  page: number;
  totalPages: number;
  siteDomain: string;
  username?: string;
}) {
  return (
    <Layout title="Projects" username={username}>
      <h1>Projects</h1>
      <ProjectsTable projects={projects} siteDomain={siteDomain} />
      <Pagination page={page} totalPages={totalPages} baseUrl="/admin/projects" />
    </Layout>
  );
}
