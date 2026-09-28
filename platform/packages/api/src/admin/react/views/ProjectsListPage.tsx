/** @jsxImportSource @voidcloud/api/admin-jsx */
import { useEffect, useState } from 'react';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import type { ProjectRow } from './ProjectsTable.tsx';
import { ProjectsTable } from './ProjectsTable.tsx';
import { SearchForm } from './SearchForm.tsx';

export function ProjectsListPage({
  projects,
  search,
  page,
  totalPages,
  siteDomain,
  platformName,
  username,
}: {
  projects: ReadonlyArray<ProjectRow>;
  search?: string;
  page?: number;
  totalPages?: number;
  siteDomain: string;
  platformName: string;
  username?: string;
}) {
  const [filter, setFilter] = useState(search ?? '');
  useEffect(() => setFilter(search ?? ''), [search]);
  const visibleProjects = projects.filter((project) =>
    [project.slug, project.owner_login, project.type, project.last_deploy_status].some((value) =>
      value?.toLowerCase().includes(filter.toLowerCase()),
    ),
  );
  return (
    <Layout platformName={platformName} title="Projects" username={username}>
      <h1>Projects</h1>
      <SearchForm
        action="/admin/projects"
        label="Search projects"
        value={filter}
        onChange={setFilter}
        suggestions={projects.flatMap((project) => [project.slug, project.owner_login])}
        initialValue={search}
        showClear={Boolean(search)}
      />
      <ProjectsTable projects={visibleProjects} siteDomain={siteDomain} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/projects" />
      )}
    </Layout>
  );
}
