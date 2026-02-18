import type { User, Project } from "@vite-cloud/platform/types";
import type { PlanId } from "@vite-cloud/platform/tiers";
import { PLAN_LIMITS, getPlanLimits } from "@vite-cloud/platform/tiers";
import { Layout } from "./layout";
import { formatLimit } from "./format";

export function UserDetailPage({
  user,
  projects,
  deploysToday,
}: {
  user: User;
  projects: Project[];
  deploysToday: number;
}) {
  const plans = Object.keys(PLAN_LIMITS) as PlanId[];
  const limits = getPlanLimits(user.plan);

  return (
    <Layout title={user.login}>
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
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Plan</h2>
        <form
          method="post"
          action={`/users/${user.id}/plan`}
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
            Update Plan
          </button>
        </form>
      </div>

      <div class="card mb-1">
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Plan Limits</h2>
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
        <h2 style="font-size: 1.125rem; margin-bottom: 1rem">Suspension</h2>
        {user.suspended_reason ? (
          <form method="post" action={`/users/${user.id}/unsuspend`}>
            <button class="btn btn-primary" type="submit">
              Unsuspend
            </button>
          </form>
        ) : (
          <form
            method="post"
            action={`/users/${user.id}/suspend`}
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
                <th>Name</th>
                <th>Slug</th>
                <th>Mode</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={`/projects/${p.id}`}>{p.name}</a>
                  </td>
                  <td>{p.slug}</td>
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
