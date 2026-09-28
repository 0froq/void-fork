/** @jsxImportSource @voidcloud/api/admin-jsx */

import { useEffect, useMemo, useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { ProjectsPageView, projectsPageRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { ProjectsTable } from './ProjectsTable.tsx';
import { SearchForm } from './SearchForm.tsx';
import { type SearchSuggestion } from './SearchTypeahead.tsx';

export function ProjectsListPage({ path, platformName, username }: AdminPageProps) {
  const { projectsPage: ref } = useRequest(projectsPageRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(ProjectsPageView, ref);
  if (!pageData) {
    throw new Error('Projects page data is unavailable.');
  }
  const { projects, search, page, totalPages, siteDomain, tz } = pageData;
  const [filter, setFilter] = useState(search ?? '');
  useEffect(() => setFilter(search ?? ''), [search]);
  const visibleProjects = projects.filter((project) =>
    [project.slug, project.owner_login, project.type, project.last_deploy_status].some((value) =>
      value?.toLowerCase().includes(filter.toLowerCase()),
    ),
  );
  const suggestions = useMemo<ReadonlyArray<SearchSuggestion>>(
    () =>
      projects.map((project) => ({
        id: project.id,
        label: project.slug,
        keywords: [project.owner_login, project.id, project.type, project.last_deploy_status],
        description: project.owner_login ?? undefined,
      })),
    [projects],
  );
  return (
    <Layout platformName={platformName} title="Projects" username={username}>
      <h1>Projects</h1>
      <SearchForm
        action="/admin/projects"
        label="Search projects"
        value={filter}
        onChange={setFilter}
        suggestions={suggestions}
        initialValue={search}
        showClear={Boolean(search)}
      />
      <ProjectsTable projects={visibleProjects} siteDomain={siteDomain} tz={tz} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/projects" />
      )}
    </Layout>
  );
}
