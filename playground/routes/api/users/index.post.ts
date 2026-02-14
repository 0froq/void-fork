import { defineHandler } from "vite-plugin-cloud";

export default defineHandler(async (ctx) => {
  const body = await ctx.request.json<{ name: string; email: string }>();
  await ctx.env.db
    .prepare("INSERT INTO users (name, email) VALUES (?, ?)")
    .bind(body.name, body.email)
    .run();
  return { created: true };
});
