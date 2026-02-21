import { defineHandler } from "vite-cloud";
import { USERS } from "./_data";

export const loader = defineHandler((c) => {
  const id = Number(c.req.param("id"));
  const user = USERS.find((u) => u.id === id);

  if (!user) {
    return c.notFound();
  }

  return { user };
});
