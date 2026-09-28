/** @jsxImportSource @voidcloud/api/admin-jsx */

import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading } from '@astryxdesign/core/Text';
import { useRequest, useView } from 'react-fate';
import type { CliVersionDeploymentStats } from '../../../db.ts';
import { CliVersionsView, cliVersionsRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { formatDateTime, formatNumber } from './format.ts';
import { Layout } from './Layout.tsx';

function CliVersionTable({
  rows,
  title,
  tz,
}: {
  rows: ReadonlyArray<CliVersionDeploymentStats>;
  title: string;
  tz?: string;
}) {
  return (
    <>
      <Heading level={2}>{title}</Heading>
      {rows.length === 0 ? (
        <p>
          <em>No deployments found.</em>
        </p>
      ) : (
        <Table hasHover>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Version</TableHeaderCell>
              <TableHeaderCell>Deploys</TableHeaderCell>
              <TableHeaderCell>Projects</TableHeaderCell>
              <TableHeaderCell>Users</TableHeaderCell>
              <TableHeaderCell>First Seen</TableHeaderCell>
              <TableHeaderCell>Last Seen</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.cli_version ?? 'unknown'}>
                <TableCell>{row.cli_version ?? 'unknown'}</TableCell>
                <TableCell>{formatNumber(row.deployments)}</TableCell>
                <TableCell>{formatNumber(row.projects)}</TableCell>
                <TableCell>{formatNumber(row.users)}</TableCell>
                <TableCell>{formatDateTime(row.first_seen, tz)}</TableCell>
                <TableCell>{formatDateTime(row.last_seen, tz)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

export function CliVersionsPage({ path, platformName, username }: AdminPageProps) {
  const { cliVersions: ref } = useRequest(cliVersionsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(CliVersionsView, ref);
  if (!pageData) {
    throw new Error('CLI version data is unavailable.');
  }
  const { allTime, last30Days, tz } = pageData;
  return (
    <Layout platformName={platformName} title="CLI Versions" username={username}>
      <Heading level={1}>CLI Versions</Heading>
      <CliVersionTable rows={last30Days} title="Last 30 Days" tz={tz} />
      <CliVersionTable rows={allTime} title="All Time" tz={tz} />
    </Layout>
  );
}
