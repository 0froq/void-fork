import { defineHandler } from "vite-cloud";

export default defineHandler(async (c) => {
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(c.req.param("id"))
    .first();

  if (!user) {
    return new Response("Not found", { status: 404 });
  }
  return user;
});
