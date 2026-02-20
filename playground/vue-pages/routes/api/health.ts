import { defineHandler } from "vite-cloud";

export const GET = defineHandler((c) => {
  return c.json({ status: "ok" });
});
