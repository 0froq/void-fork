/** @jsxImportSource @voidcloud/api/admin-jsx */
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import type { Project } from '../../../types.ts';
import { formatAbsoluteDate, formatAbsoluteDateTime } from './format.ts';
import { ProjectUrlLink } from './ProjectUrlLink.tsx';

export type ProjectRow = Project & {
  url?: string;
  owner_login: string | null;
  last_deploy: string | null;
  last_deploy_id: string | null;
  last_deploy_status: string | null;
};

export function ProjectsTable({
  projects,
  siteDomain,
}: {
  projects: ReadonlyArray<ProjectRow>;
  siteDomain: string;
}) {
  return (
    <>
      <Table className="void-admin-projects-table" hasHover>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Slug</TableHeaderCell>
            <TableHeaderCell>URL</TableHeaderCell>
            <TableHeaderCell>Owner</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Created</TableHeaderCell>
            <TableHeaderCell>Last Deploy</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <a href={`/admin/projects/${p.id}`}>{p.slug}</a>
              </TableCell>
              <TableCell>
                <ProjectUrlLink url={p.url ?? `https://${p.slug}.${siteDomain}`} />
              </TableCell>
              <TableCell>
                {p.owner_login ? <a href={`/admin/users/${p.user_id}`}>{p.owner_login}</a> : '-'}
              </TableCell>
              <TableCell>{p.type}</TableCell>
              <TableCell>{formatAbsoluteDate(p.created_at)}</TableCell>
              <TableCell>
                {p.last_deploy ? (
                  <>
                    <span
                      style={`display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:10px;vertical-align:middle;background:${p.last_deploy_status === 'failed' ? '#dc2626' : '#16a34a'}`}
                    />
                    {p.last_deploy_id ? (
                      <a href={`/admin/deployments/${p.last_deploy_id}`}>
                        {formatAbsoluteDateTime(p.last_deploy)}
                      </a>
                    ) : (
                      formatAbsoluteDateTime(p.last_deploy)
                    )}
                  </>
                ) : (
                  '-'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {projects.length === 0 && (
        <p>
          <em>No projects found.</em>
        </p>
      )}
    </>
  );
}
