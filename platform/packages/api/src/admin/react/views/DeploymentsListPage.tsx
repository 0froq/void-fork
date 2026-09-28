/** @jsxImportSource @voidcloud/api/admin-jsx */
import { useEffect, useState } from 'react';
import type { Deployment } from '../../../types.ts';
import { DeploymentTable } from './DeploymentTable.tsx';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { SearchForm } from './SearchForm.tsx';

export function DeploymentsListPage({
  deployments,
  search,
  page,
  totalPages,
  platformName,
  username,
  tz,
}: {
  deployments: ReadonlyArray<Deployment & { project_slug: string | null }>;
  search?: string;
  page?: number;
  totalPages?: number;
  platformName: string;
  username?: string;
  tz?: string;
}) {
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
        showClear={Boolean(search)}
      />
      <DeploymentTable deployments={visibleDeployments} showProject tz={tz} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/deployments" />
      )}
    </Layout>
  );
}
