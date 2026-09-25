/** @jsxImportSource @voidcloud/api/admin-jsx */
import { useEffect, useState, type ChangeEvent } from 'react';
import type { Deployment } from '../../../types.ts';
import { DeploymentTable } from './deployment-table.tsx';
import { Layout } from './layout.tsx';
import { Pagination } from './pagination.tsx';

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
      <form method="get" action="/admin/deployments" style="margin-bottom: 10px">
        <input
          type="text"
          name="search"
          placeholder="Search deployments..."
          value={filter}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)}
          id="search-input"
        />{' '}
        <button type="submit">Search</button>
        {search && (
          <>
            {' '}
            | <a href="/admin/deployments">Clear</a>
          </>
        )}
      </form>
      <DeploymentTable deployments={visibleDeployments} showProject tz={tz} />
      {page != null && totalPages != null && (
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/deployments" />
      )}
    </Layout>
  );
}
