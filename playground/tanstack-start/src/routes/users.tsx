import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const getUsers = createServerFn().handler(async () => {
  const result = await env.DB.prepare("SELECT * FROM users ORDER BY id").all();
  return result.results as { id: number; name: string; email: string }[];
});

export const Route = createFileRoute("/users")({
  loader: () => getUsers(),
  component: UsersPage,
});

function UsersPage() {
  const users = Route.useLoaderData();

  return (
    <div style={{ padding: "16px" }}>
      <h1>Users</h1>
      <p>Fetched from D1 via a server function:</p>
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
