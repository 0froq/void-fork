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
import type { CliVersionDeploymentStats } from '../../../db.ts';
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

export function CliVersionsPage({
  allTime,
  last30Days,
  platformName,
  username,
  tz,
}: {
  allTime: ReadonlyArray<CliVersionDeploymentStats>;
  last30Days: ReadonlyArray<CliVersionDeploymentStats>;
  platformName: string;
  username?: string;
  tz?: string;
}) {
  return (
    <Layout platformName={platformName} title="CLI Versions" username={username}>
      <Heading level={1}>CLI Versions</Heading>
      <CliVersionTable rows={last30Days} title="Last 30 Days" tz={tz} />
      <CliVersionTable rows={allTime} title="All Time" tz={tz} />
    </Layout>
  );
}
