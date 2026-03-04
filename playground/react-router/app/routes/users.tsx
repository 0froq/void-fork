import { env } from "cloudflare:workers";
import type { Route } from "./+types/users";

export async function loader() {
  const result = await env.DB.prepare("SELECT * FROM users ORDER BY id").all();
  return { users: result.results as { id: number; name: string; email: string }[] };
}

export default function UsersPage({ loaderData }: Route.ComponentProps) {
  const { users } = loaderData;

  return (
    <div style={{ padding: "16px" }}>
      <h1>Users</h1>
      <p>Fetched from D1 via a loader:</p>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.id}</td>
              <td>{user.name}</td>
              <td>{user.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
