/** @jsxImportSource @voidcloud/api/admin-jsx */
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import type { Deployment } from '../../../types.ts';
import { formatDateTime } from './format.ts';

export function displayStatus(
  d: Deployment,
  activeDeploymentId: string | null | undefined,
): string {
  if (d.status === 'failed') {
    return 'failed';
  }
  if (d.status !== 'live') {
    return d.status;
  }
  if (d.id === activeDeploymentId) {
    return 'live';
  }
  if (d.retained) {
    return 'retained';
  }
  return 'evicted';
}

function statusColor(status: string): string | undefined {
  switch (status) {
    case 'live':
      return 'color: #16a34a; font-weight: 600';
    case 'retained':
      return 'color: #16a34a';
    case 'evicted':
      return 'color: #888';
    case 'failed':
    case 'canceled':
      return 'color: #dc2626';
    case 'canceling':
      return 'color: #ca8a04';
    default:
      return undefined;
  }
}

export function DeploymentTable({
  deployments,
  activeDeploymentId,
  showProject,
  tz,
}: {
  deployments: ReadonlyArray<
    Deployment & {
      project_slug?: string | null;
      active_deployment_id?: string | null;
    }
  >;
  activeDeploymentId?: string | null;
  showProject?: boolean;
  tz?: string;
}) {
  if (deployments.length === 0) {
    return (
      <p>
        <em>No deployments found.</em>
      </p>
    );
  }
  return (
    <Table hasHover>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          {showProject && <TableHeaderCell>Project</TableHeaderCell>}
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>CLI</TableHeaderCell>
          <TableHeaderCell>Commit</TableHeaderCell>
          <TableHeaderCell>Error</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deployments.map((d) => {
          const activeId = activeDeploymentId ?? d.active_deployment_id;
          const status = displayStatus(d, activeId);
          return (
            <TableRow key={d.id}>
              <TableCell>
                <a href={`/admin/deployments/${d.id}`}>{d.id}</a>
              </TableCell>
              {showProject && (
                <TableCell>
                  {d.project_slug ? (
                    <a href={`/admin/projects/${d.project_id}`}>{d.project_slug}</a>
                  ) : (
                    '-'
                  )}
                </TableCell>
              )}
              <TableCell>
                <span style={statusColor(status)}>{status}</span>
              </TableCell>
              <TableCell>{d.source ?? '-'}</TableCell>
              <TableCell>{d.cli_version ?? '-'}</TableCell>
              <TableCell>{d.commit ? d.commit.slice(0, 7) : '-'}</TableCell>
              <TableCell>
                {d.error_message ? (
                  <>
                    <span style="color: red; max-width: 400px; display: inline-block; word-break: break-word">
                      {d.error_message}
                    </span>
                    <br />
                    <button
                      type="button"
                      class="copy-btn"
                      data-copy={d.error_message}
                      style="font-size: 0.65rem; padding: 1px 5px; float: right; margin-top: 5px"
                    >
                      copy
                    </button>
                  </>
                ) : (
                  '-'
                )}
              </TableCell>
              <TableCell>{formatDateTime(d.created_at, tz)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
