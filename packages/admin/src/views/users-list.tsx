import type { User } from "@vite-cloud/platform/types";
import { Layout } from "./layout";

function planBadge(plan: string) {
  const cls =
    plan === "pro"
      ? "badge-purple"
      : plan === "solo"
        ? "badge-blue"
        : plan === "sponsored"
          ? "badge-green"
          : "badge-gray";
  return <span class={`badge ${cls}`}>{plan}</span>;
}

function roleBadge(role: string) {
  return role === "admin" ? (
    <span class="badge badge-purple">{role}</span>
  ) : (
    <span class="badge badge-gray">{role}</span>
  );
}

export function UsersListPage({ users, search }: { users: User[]; search?: string }) {
  return (
    <Layout title="Users">
      <h1>Users</h1>
      <form class="search-form" method="get" action="/users">
        <input type="text" name="search" placeholder="Search users..." value={search ?? ""} />
        <button class="btn btn-primary" type="submit">
          Search
        </button>
        {search && (
          <a href="/users" class="btn">
            Clear
          </a>
        )}
      </form>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Login</th>
              <th>Provider</th>
              <th>Email</th>
              <th>Plan</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <a href={`/users/${user.id}`}>{user.login}</a>
                </td>
                <td>{user.provider}</td>
                <td>{user.email ?? "-"}</td>
                <td>{planBadge(user.plan)}</td>
                <td>{roleBadge(user.role)}</td>
                <td>
                  {user.suspended_reason ? (
                    <span class="badge badge-red">suspended</span>
                  ) : (
                    <span class="badge badge-green">active</span>
                  )}
                </td>
                <td>{new Date(user.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <p style="padding: 1rem; color: #6b7280">No users found.</p>}
      </div>
    </Layout>
  );
}
