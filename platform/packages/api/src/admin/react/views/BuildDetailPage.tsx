/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { Build } from '../../../types.ts';
import { BuildLogs } from './BuildLogs.tsx';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';

export function BuildDetailPage({
  build,
  tz,
  platformName,
  username,
}: {
  build: Build;
  tz?: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title={`Build ${build.id}`} username={username}>
      <h1>Build {build.id}</h1>

      <table>
        <tbody>
          <tr>
            <th>Status</th>
            <td>{build.status}</td>
          </tr>
          <tr>
            <th>Project</th>
            <td>
              <a href={`/admin/projects/${build.project_id}`}>{build.project_id}</a>
            </td>
          </tr>
          <tr>
            <th>Executor</th>
            <td>{build.executor}</td>
          </tr>
          <tr>
            <th>Instance Type</th>
            <td>{build.instance_type ?? '-'}</td>
          </tr>
          <tr>
            <th>Commit</th>
            <td>{build.commit_sha ? build.commit_sha.slice(0, 7) : '-'}</td>
          </tr>
          <tr>
            <th>Branch</th>
            <td>{build.branch ?? '-'}</td>
          </tr>
          <tr>
            <th>Deployment</th>
            <td>
              {build.deployment_id ? (
                <a href={`/admin/deployments/${build.deployment_id}`}>{build.deployment_id}</a>
              ) : (
                '-'
              )}
            </td>
          </tr>
          {build.error ? (
            <tr>
              <th>Error</th>
              <td>
                <span style="color: red; max-width: 600px; display: inline-block; word-break: break-word">
                  {build.error}
                </span>
              </td>
            </tr>
          ) : null}
          <tr>
            <th>Exit Code</th>
            <td>{build.exit_code ?? '-'}</td>
          </tr>
          <tr>
            <th>Started</th>
            <td>{build.started_at ? formatDateTime(build.started_at, tz) : '-'}</td>
          </tr>
          <tr>
            <th>Completed</th>
            <td>{build.completed_at ? formatDateTime(build.completed_at, tz) : '-'}</td>
          </tr>
          <tr>
            <th>Created</th>
            <td>{formatDateTime(build.created_at, tz)}</td>
          </tr>
        </tbody>
      </table>

      {build.executor === 'container' ? (
        <BuildLogs build={build} />
      ) : (
        <>
          <h2>Build Logs</h2>
          {build.logs_url ? (
            <p>
              <a href={build.logs_url} target="_blank" rel="noopener noreferrer">
                View logs on GitHub ↗
              </a>
            </p>
          ) : (
            <p>
              <em>No external logs available.</em>
            </p>
          )}
        </>
      )}
    </Layout>
  );
}
