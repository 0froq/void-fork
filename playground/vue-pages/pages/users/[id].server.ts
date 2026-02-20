import { defineHandler } from "vite-cloud";

const USERS = [
  { id: 1, name: "Alice", email: "alice@example.com", created_at: "2025-01-01" },
  { id: 2, name: "Bob", email: "bob@example.com", created_at: "2025-01-02" },
];

export const loader = defineHandler((c) => {
  const id = Number(c.req.param("id"));
  const user = USERS.find((u) => u.id === id);

  if (!user) {
    return c.notFound();
  }

  return { user };
});
