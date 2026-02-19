import type { User, Project } from "../../types";
import type { PlanId } from "../../tiers";
import { PLAN_LIMITS, getPlanLimits } from "../../tiers";
import { Layout } from "./layout";
import { formatLimit, formatNumber, formatBytes } from "./format";

interface ProjectUsage {
  projectId: string;
  slug: string;
  requests: number;
  bandwidthBytes: number;
}

export function UserDetailPage({
  user,
  projects,
  deploysToday,
  usage,
  username,
}: {
  user: User;
  projects: Project[];
  deploysToday: number;
  usage: {
    billingPeriodStart: string;
    totalRequests: number;
    totalBandwidth: number;
    projects: ProjectUsage[];
  };
  username?: string;
}) {
  const plans = Object.keys(PLAN_LIMITS) as PlanId[];
  const limits = getPlanLimits(user.plan);

  return (
    <Layout title={user.login} username={username}>
      <h1>{user.login}</h1>

      <div class="card mb-1">
        <table>
          <tbody>
            <tr>
              <th>ID</th>
              <td>{user.id}</td>
            </tr>
            <tr>
              <th>Provider</th>
              <td>{user.provider}</td>
            </tr>
            <tr>
              <th>Email</th>
              <td>{user.email ?? "-"}</td>
            </tr>
            <tr>
              <th>Role</th>
              <td>{user.role}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>
                {user.suspended_reason ? (
                  <span class="badge badge-red">suspended: {user.suspended_reason}</span>
                ) : (
                  <span class="badge badge-green">active</span>
                )}
              </td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{user.created_at}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card mb-1">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem">
          <h2 style="font-size: 1.125rem; margin: 0">Plan</h2>
          <form
            method="post"
            action={`/admin/users/${user.id}/plan`}
            style="display: flex; gap: 0.5rem; align-items: center"
          >
            <select name="plan">
              {plans.map((p) => (
                <option key={p} value={p} selected={p === user.plan}>
                  {p}
                </option>
              ))}
            </select>
            <button class="btn btn-primary" type="submit">
              Update
            </button>
          </form>
        </div>
        <table>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Requests / month</td>
              <td>{formatLimit(limits.requestsPerMonth)}</td>
            </tr>
            <tr>
              <td>CPU ms / request</td>
              <td>{formatLimit(limits.cpuMsPerRequest)}</td>
            </tr>
            <tr>
              <td>Sub-requests / invocation</td>
              <td>{formatLimit(limits.subRequestsPerInvocation)}</td>
            </tr>
            <tr>
              <td>Deploys / day</td>
              <td>
                {deploysToday} / {formatLimit(limits.deploysPerDay)}
              </td>
            </tr>
            <tr>
              <td>D1 storage</td>
              <td>{formatLimit(limits.d1StorageBytes, "bytes")}</td>
            </tr>
            <tr>
              <td>R2 storage</td>
              <td>{formatLimit(limits.r2StorageBytes, "bytes")}</td>
            </tr>
            <tr>
              <td>KV storage</td>
              <td>{formatLimit(limits.kvStorageBytes, "bytes")}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card mb-1">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">
          Current Usage
          <span style="font-size: 0.8rem; font-weight: normal; color: #6b7280">
            {" "}
            (since {new Date(usage.billingPeriodStart).toLocaleDateString()})
          </span>
        </h2>
        <div style="display: flex; flex-direction: column; gap: 1rem">
          <UsageBar
            label="Requests / month"
            used={usage.totalRequests}
            limit={limits.requestsPerMonth}
            formatValue={formatNumber}
          />
          <UsageBar
            label="Deploys / day"
            used={deploysToday}
            limit={limits.deploysPerDay}
            formatValue={formatNumber}
          />
          <div style="font-size: 0.875rem; color: #6b7280">
            Bandwidth: {formatBytes(usage.totalBandwidth)}
          </div>
        </div>
        {usage.projects.length > 1 && (
          <>
            <h3 style="font-size: 0.95rem; margin: 1rem 0 0.5rem">Per Project</h3>
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Requests</th>
                  <th>Bandwidth</th>
                </tr>
              </thead>
              <tbody>
                {usage.projects.map((p) => (
                  <tr key={p.projectId}>
                    <td>
                      <a href={`/admin/projects/${p.projectId}`}>{p.slug}</a>
                    </td>
                    <td>{formatNumber(p.requests)}</td>
                    <td>{formatBytes(p.bandwidthBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div class="card mb-1">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Suspension</h2>
        {user.suspended_reason ? (
          <form method="post" action={`/admin/users/${user.id}/unsuspend`}>
            <button class="btn btn-primary" type="submit">
              Unsuspend
            </button>
          </form>
        ) : (
          <form
            method="post"
            action={`/admin/users/${user.id}/suspend`}
            style="display: flex; gap: 0.5rem; align-items: center"
          >
            <input type="text" name="reason" placeholder="Reason..." value="admin_suspended" />
            <button class="btn btn-danger" type="submit">
              Suspend
            </button>
          </form>
        )}
      </div>

      <div class="card">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Projects ({projects.length})</h2>
        {projects.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Slug</th>
                <th>Mode</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={`/admin/projects/${p.id}`}>{p.slug}</a>
                  </td>
                  <td>{p.mode}</td>
                  <td>{new Date(p.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style="color: #6b7280">No projects.</p>
        )}
      </div>
    </Layout>
  );
}

function UsageBar({
  label,
  used,
  limit,
  formatValue,
}: {
  label: string;
  used: number;
  limit: number;
  formatValue: (n: number) => string;
}) {
  const unlimited = limit === 0;
  const pct = unlimited ? 0 : Math.min((used / limit) * 100, 100);
  const overLimit = !unlimited && used >= limit;
  const barColor = overLimit ? "#dc2626" : pct > 80 ? "#f59e0b" : "#3b82f6";

  return (
    <div>
      <div style="display: flex; justify-content: space-between; font-size: 0.875rem; margin-bottom: 0.25rem">
        <span>{label}</span>
        <span>
          {formatValue(used)} / {unlimited ? "Unlimited" : formatValue(limit)}
        </span>
      </div>
      <div style="background: #e5e7eb; border-radius: 4px; height: 8px; overflow: hidden">
        {unlimited ? (
          <div style="width: 100%; height: 100%; background: repeating-linear-gradient(-45deg, #d1d5db, #d1d5db 4px, #e5e7eb 4px, #e5e7eb 8px)" />
        ) : (
          <div
            style={`width: ${pct}%; height: 100%; background: ${barColor}; border-radius: 4px; transition: width 0.3s`}
          />
        )}
      </div>
    </div>
  );
}
