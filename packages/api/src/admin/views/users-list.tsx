import type { User } from "../../types";
import { Layout } from "./layout";
import { Pagination } from "./pagination";

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

export function UsersListPage({
  users,
  search,
  page,
  totalPages,
  username,
}: {
  users: User[];
  search?: string;
  page?: number;
  totalPages?: number;
  username?: string;
}) {
  return (
    <Layout title="Users" username={username}>
      <h1>Users</h1>
      <form class="search-form" method="get" action="/admin/users">
        <input type="text" name="search" placeholder="Search users..." value={search ?? ""} />
        <button class="btn btn-primary" type="submit">
          Search
        </button>
        {search && (
          <a href="/admin/users" class="btn">
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
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <a href={`/admin/users/${user.id}`}>{user.login}</a>
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
                <td>
                  <form
                    method="post"
                    action={`/admin/users/${user.id}/delete`}
                    style="display: inline"
                    onsubmit={`return confirm('Delete user "${user.login}" and all their projects?')`}
                  >
                    <button
                      class="btn btn-danger"
                      type="submit"
                      style="font-size: 0.75rem; padding: 0.2rem 0.5rem"
                    >
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && <p style="padding: 1rem; color: #6b7280">No users found.</p>}
        {page != null && totalPages != null && (
          <Pagination page={page} totalPages={totalPages} baseUrl="/admin/users" />
        )}
      </div>
    </Layout>
  );
}
