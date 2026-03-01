import type { Deployment } from "../../types";
import { formatDateTime } from "./format";

export function DeploymentTable({
  deployments,
  showProject,
  tz,
}: {
  deployments: (Deployment & { project_slug?: string | null })[];
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
    <table>
      <thead>
        <tr>
          <th>ID</th>
          {showProject && <th>Project</th>}
          <th>Status</th>
          <th>Source</th>
          <th>Commit</th>
          <th>Error</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {deployments.map((d) => (
          <tr key={d.id}>
            <td>
              <a href={`/admin/deployments/${d.id}`}>{d.id}</a>
            </td>
            {showProject && (
              <td>
                {d.project_slug ? (
                  <a href={`/admin/projects/${d.project_id}`}>{d.project_slug}</a>
                ) : (
                  "-"
                )}
              </td>
            )}
            <td
              style={
                d.status === "live"
                  ? "color: green"
                  : d.status === "failed"
                    ? "color: red"
                    : undefined
              }
            >
              {d.status}
            </td>
            <td>{d.source ?? "-"}</td>
            <td>{d.commit ? d.commit.slice(0, 7) : "-"}</td>
            <td>
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
                "-"
              )}
            </td>
            <td>{formatDateTime(d.created_at, tz)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
