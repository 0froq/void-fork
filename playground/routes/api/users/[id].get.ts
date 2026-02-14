import { defineHandler } from "vite-plugin-cloud";

export default defineHandler(async (ctx) => {
  const user = await ctx.env.db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(ctx.params.id)
    .first();

  if (!user) {
    return new Response("Not found", { status: 404 });
  }
  return user;
});
