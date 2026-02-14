import { defineHandler } from "vite-cloud";

export default defineHandler(async (c) => {
  const body = await c.req.json<{ name: string; email: string }>();
  await c.env.DB.prepare("INSERT INTO users (name, email) VALUES (?, ?)")
    .bind(body.name, body.email)
    .run();
  return { created: true };
});
