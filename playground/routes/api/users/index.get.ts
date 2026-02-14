import { defineHandler } from "vite-plugin-cloud";

export default defineHandler(async (ctx) => {
  const result = await ctx.env.db.prepare("SELECT * FROM users").all();
  return result.results;
});
