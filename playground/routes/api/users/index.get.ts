import { defineHandler } from "vite-cloud";

export default defineHandler(async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM users").all();
  return result.results;
});
