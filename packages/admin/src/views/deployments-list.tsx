import type { Deployment } from "@vite-cloud/platform/types";
import { Layout } from "./layout";
import { Pagination } from "./pagination";

export function DeploymentsListPage({
  deployments,
  page,
  totalPages,
  username,
}: {
  deployments: (Deployment & { project_slug: string | null; project_name: string | null })[];
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
                    <a href={`/deployments/${d.id}`}>{d.id}</a>
                  </td>
                  <td>
                    {d.project_slug ? (
                      <a href={`/projects/${d.project_id}`}>{d.project_name ?? d.project_slug}</a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    <span class={`badge ${statusCls}`}>{d.status}</span>
                  </td>
                  <td>{d.source ?? "-"}</td>
                  <td style="color: #dc2626; font-size: 0.8rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                    {d.error_message ? d.error_message.slice(0, 60) : "-"}
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
        <Pagination page={page} totalPages={totalPages} baseUrl="/deployments" />
      </div>
    </Layout>
  );
}
