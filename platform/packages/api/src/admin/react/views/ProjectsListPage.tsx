/** @jsxImportSource @voidcloud/api/admin-jsx */
import { useEffect, useState, type ChangeEvent } from 'react';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import type { ProjectRow } from './ProjectsTable.tsx';
import { ProjectsTable } from './ProjectsTable.tsx';

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
      <form method="get" action="/admin/projects" style="margin-bottom: 10px">
        <input
          type="text"
          name="search"
          placeholder="Search projects..."
          value={filter}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)}
          id="search-input"
        />{' '}
        <button type="submit">Search</button>
        {search && (
          <>
            {' '}
            | <a href="/admin/projects">Clear</a>
          </>
        )}
      </form>
      <ProjectsTable projects={visibleProjects} siteDomain={siteDomain} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/projects" />
      )}
    </Layout>
  );
}
