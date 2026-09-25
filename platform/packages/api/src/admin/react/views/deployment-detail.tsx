/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { DeployManifest, Deployment, Project } from '../../../types.ts';
import { DeploymentLogs } from './deployment-logs.tsx';
import { displayStatus } from './deployment-table.tsx';
import { formatDateTime } from './format.ts';
import { Layout } from './layout.tsx';

export function DeploymentDetailPage({
  deployment,
  project,
  manifest,
  canCancel,
  tz,
  platformName,
  username,
}: {
  deployment: Deployment;
  project: Project | null;
  manifest: DeployManifest | null;
  canCancel: boolean;
  tz?: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title={`Deployment ${deployment.id}`} username={username}>
      <h1>Deployment {deployment.id}</h1>

      {canCancel && (
        <>
          <h2>Deploy Control</h2>
          <form
            method="post"
            action={`/admin/deployments/${deployment.id}/cancel`}
            data-confirm={`Cancel deployment "${deployment.id}"?`}
            data-deployment={deployment.id}
          >
            <button type="submit" class="danger">
              Cancel Deploy
            </button>
          </form>
        </>
      )}

      {(deployment.status === 'failed' || deployment.status === 'canceled') &&
        deployment.error_message && (
          <>
            <h2>Error</h2>
            <pre>{deployment.error_message}</pre>
            <p>
              <button type="button" class="copy-btn" data-copy={deployment.error_message}>
                Copy error
              </button>
            </p>
          </>
        )}

      <table>
        <tbody>
          <tr>
            <th>ID</th>
            <td>{deployment.id}</td>
            <th>Project</th>
            <td>
              {project ? (
                <a href={`/admin/projects/${project.id}`}>{project.slug}</a>
              ) : (
                deployment.project_id
              )}
            </td>
          </tr>
          <tr>
            <th>Status</th>
            <td
              style={(() => {
                const s = displayStatus(deployment, project?.active_deployment_id);
                if (s === 'live') {
                  return 'color: #16a34a; font-weight: 600';
                }
                if (s === 'retained') {
                  return 'color: #16a34a';
                }
                if (s === 'evicted') {
                  return 'color: #888';
                }
                if (s === 'failed') {
                  return 'color: #dc2626';
                }
                return undefined;
              })()}
            >
              {displayStatus(deployment, project?.active_deployment_id)}
            </td>
            <th>Source</th>
            <td>{deployment.source ?? '-'}</td>
          </tr>
          <tr>
            <th>Commit</th>
            <td>{deployment.commit ?? '-'}</td>
            <th>Created</th>
            <td>{formatDateTime(deployment.created_at, tz)}</td>
          </tr>
          <tr>
            <th>Deployed</th>
            <td>{deployment.deployed_at ? formatDateTime(deployment.deployed_at, tz) : '-'}</td>
            <th>Type</th>
            <td>{project?.type ?? '-'}</td>
          </tr>
          <tr>
            <th>CLI Version</th>
            <td>{deployment.cli_version ?? '-'}</td>
            <th />
            <td />
          </tr>
          {manifest && (
            <tr>
              <td colspan={4} style="padding: 0">
                <details>
                  <summary style="padding: 8px; cursor: pointer; font-weight: 600">
                    Manifest
                  </summary>
                  <div style="padding: 0 8px 8px">
                    <table style="margin: 0">
                      <tbody>
                        {manifest.bindings &&
                          Object.entries(manifest.bindings).map(([type, value]) =>
                            Array.isArray(value) && value.length > 0 ? (
                              <tr key={type}>
                                <th>{type.toUpperCase()}</th>
                                <td>
                                  {value.map((n: string, i: number) => (
                                    <span key={n}>
                                      {i > 0 && ', '}
                                      <code>{n}</code>
                                    </span>
                                  ))}
                                </td>
                              </tr>
                            ) : value === true ? (
                              <tr key={type}>
                                <th>{type.toUpperCase()}</th>
                                <td>enabled</td>
                              </tr>
                            ) : null,
                          )}
                        {manifest.migrations && (
                          <tr>
                            <th>Migrations</th>
                            <td>
                              {manifest.migrations.dialect} — {manifest.migrations.pending} pending
                            </td>
                          </tr>
                        )}
                        {manifest.schedules && manifest.schedules.length > 0 && (
                          <tr>
                            <th>Schedules</th>
                            <td>
                              {manifest.schedules.map((s, i) => (
                                <span key={s.name}>
                                  {i > 0 && ', '}
                                  {s.name}: {s.cron}
                                </span>
                              ))}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {deployment.manifest && (
                      <details style="margin-top: 8px">
                        <summary style="cursor: pointer; font-size: 0.85rem">Raw JSON</summary>
                        <pre style="margin-top: 8px; font-size: 0.8rem">
                          {JSON.stringify(JSON.parse(deployment.manifest), null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </details>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {deployment.status === 'live' && project && <DeploymentLogs deploymentId={deployment.id} />}
    </Layout>
  );
}
