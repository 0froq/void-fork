/** @jsxImportSource @voidcloud/api/admin-jsx */

import { useEffect, useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { DeploymentsPageView, deploymentsPageRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { DeploymentTable } from './DeploymentTable.tsx';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { SearchForm } from './SearchForm.tsx';

export function DeploymentsListPage({ path, platformName, username }: AdminPageProps) {
  const { deploymentsPage: ref } = useRequest(deploymentsPageRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(DeploymentsPageView, ref);
  if (!pageData) {
    throw new Error('Deployments page data is unavailable.');
  }
  const { deployments, search, page, totalPages, tz } = pageData;
  const [filter, setFilter] = useState(search ?? '');
  useEffect(() => setFilter(search ?? ''), [search]);
  const visibleDeployments = deployments.filter((deployment) =>
    [
      deployment.id,
      deployment.project_slug,
      deployment.status,
      deployment.source,
      deployment.cli_version,
      deployment.commit,
      deployment.error_message,
    ].some((value) => value?.toLowerCase().includes(filter.toLowerCase())),
  );
  return (
    <Layout platformName={platformName} title="Deployments" username={username}>
      <h1>Deployments</h1>
      <SearchForm
        action="/admin/deployments"
        label="Search deployments"
        value={filter}
        onChange={setFilter}
        suggestions={deployments.flatMap((deployment) => [
          deployment.id,
          deployment.project_slug,
          deployment.status,
          deployment.source,
          deployment.commit,
        ])}
        initialValue={search}
        showClear={Boolean(search)}
      />
      <DeploymentTable deployments={visibleDeployments} showProject tz={tz} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/deployments" />
      )}
    </Layout>
  );
}
