/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { getOperatorProject } from '../../../operator/tenant-service.ts';
import { BuildTable } from './BuildTable.tsx';
import { DeploymentTable } from './DeploymentTable.tsx';
import { Layout } from './Layout.tsx';
type Detail = Awaited<ReturnType<typeof getOperatorProject>>;
export function ProjectDetailPage({
  project,
  deployments,
  resources,
  owner,
  domains,
  builds,
  cfAccountId,
  deployUrl,
  tz,
  platformName,
  username,
}: Detail & {
  cfAccountId?: string;
  deployUrl: string;
  tz?: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout platformName={platformName} title={project.slug} username={username}>
      <h1>{project.slug}</h1>

      <table>
        <tbody>
          <tr>
            <th>ID</th>
            <td>{project.id}</td>
          </tr>
          <tr>
            <th>Slug</th>
            <td>{project.slug}</td>
          </tr>
          <tr>
            <th>URL</th>
            <td>
              <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                {deployUrl}
              </a>
            </td>
          </tr>
          <tr>
            <th>Custom Domain</th>
            <td>
              {domains.length > 0 ? (
                domains.map((d) => (
                  <span key={d.id}>
                    <a href={`https://${d.hostname}`} target="_blank" rel="noopener noreferrer">
                      {d.hostname}
                    </a>{' '}
                    ({d.status}){' '}
                  </span>
                ))
              ) : (
                <>None</>
              )}
            </td>
          </tr>
          <tr>
            <th>Owner</th>
            <td>
              {owner ? <a href={`/admin/users/${owner.id}`}>{owner.login}</a> : project.user_id}
            </td>
          </tr>
          <tr>
            <th>Type</th>
            <td>{project.type}</td>
          </tr>
          <tr>
            <th>Email</th>
            <td>
              <a href={`/admin/email/${project.id}`}>usage, limits, destinations</a>
            </td>
          </tr>
          <tr>
            <th>Created</th>
            <td>{project.created_at}</td>
          </tr>
        </tbody>
      </table>

      <h2>Resources ({resources.length})</h2>
      {resources.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Binding</th>
              <th>CF ID</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.id}>
                <td>{r.type}</td>
                <td>{r.binding_name}</td>
                <td>
                  {cfAccountId && (r.type === 'd1' || r.type === 'kv' || r.type === 'r2') ? (
                    <a
                      href={
                        r.type === 'd1'
                          ? `https://dash.cloudflare.com/${cfAccountId}/workers/d1/databases/${r.cf_id}/metrics`
                          : r.type === 'kv'
                            ? `https://dash.cloudflare.com/${cfAccountId}/workers/kv/namespaces/${r.cf_id}/metrics`
                            : `https://dash.cloudflare.com/${cfAccountId}/r2/default/buckets/${r.cf_id}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {r.cf_id}
                    </a>
                  ) : (
                    r.cf_id
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          <em>No resources provisioned.</em>
        </p>
      )}

      <h2>Recent Deployments ({deployments.length})</h2>
      <DeploymentTable
        deployments={deployments}
        activeDeploymentId={project.active_deployment_id}
        tz={tz}
      />

      <h2>Builds ({builds.length})</h2>
      <BuildTable builds={builds} tz={tz} />

      <h2>Transfer Ownership</h2>
      <p>
        Transfer this project to an existing Void Platform user. You will review the ownership,
        plan, suspension, active-work, routing, and usage-counter changes before applying them.
      </p>
      <form method="post" action={`/admin/projects/${project.id}/owner/preview`}>
        <label>
          New owner user ID
          <input type="text" name="userId" required maxlength={512} placeholder="user_..." />
        </label>{' '}
        <button type="submit">Preview Transfer</button>
      </form>

      <h2>Danger Zone</h2>
      <form
        method="post"
        action={`/admin/projects/${project.id}/delete`}
        data-confirm={`Permanently delete project "${project.slug}" and all its resources? This cannot be undone.`}
        data-slug={project.slug}
      >
        <button type="submit" class="danger">
          Delete Project
        </button>
      </form>
    </Layout>
  );
}
