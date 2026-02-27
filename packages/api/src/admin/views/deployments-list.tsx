import type { Deployment } from "../../types";
import { Layout } from "./layout";
import { Pagination } from "./pagination";

export function DeploymentsListPage({
  deployments,
  page,
  totalPages,
  username,
}: {
  deployments: (Deployment & { project_slug: string | null })[];
  page: number;
  totalPages: number;
  username?: string;
}) {
  return (
    <Layout title="Deployments" username={username}>
      <h1>Deployments</h1>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Project</th>
              <th>Status</th>
              <th>Source</th>
              <th>Commit</th>
              <th>Error</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => {
              const statusCls =
                d.status === "live"
                  ? "badge-green"
                  : d.status === "failed"
                    ? "badge-red"
                    : "badge-gray";
              return (
                <tr key={d.id}>
                  <td style="font-family: monospace; font-size: 0.8rem">
                    <a href={`/admin/deployments/${d.id}`}>{d.id}</a>
                  </td>
                  <td>
                    {d.project_slug ? (
                      <a href={`/admin/projects/${d.project_id}`}>{d.project_slug}</a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <span class={`badge ${statusCls}`}>{d.status}</span>
                  </td>
                  <td>{d.source ?? "-"}</td>
                  <td style="font-family: monospace; font-size: 0.8rem">
                    {d.commit ? d.commit.slice(0, 7) : "-"}
                  </td>
                  <td style="color: #dc2626; font-size: 0.8rem">
                    {d.error_message ? (
                      <div style="display: flex; align-items: start; gap: 0.5rem">
                        <pre style="margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; flex: 1">
                          {d.error_message}
                        </pre>
                        <button
                          type="button"
                          class="copy-btn"
                          data-copy={d.error_message}
                          title="Copy to clipboard"
                          style="flex-shrink: 0; padding: 0.25rem 0.5rem; font-size: 0.7rem; cursor: pointer; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 4px; color: #991b1b"
                        >
                          Copy
                        </button>
                      </div>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>{new Date(d.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {deployments.length === 0 && (
          <p style="padding: 1rem; color: #6b7280">No deployments found.</p>
        )}
        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/deployments" />
      </div>
    </Layout>
  );
}
