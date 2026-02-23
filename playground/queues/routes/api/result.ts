import { defineHandler } from "void";

export const GET = defineHandler(async (c) => {
  const key = c.req.query("key");
  if (!key) return c.json({ error: "missing key" }, 400);
  const value = await c.env.KV.get(key);
  if (value === null) return { found: false };
  return { found: true, value };
});
