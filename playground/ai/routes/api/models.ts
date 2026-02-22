import { defineHandler } from "vite-cloud";
import { ai } from "vite-cloud/ai";

export const GET = defineHandler(async (c) => {
  const task = c.req.query("task");
  const models = await ai.models(task ? { task } : undefined);
  return c.json(models);
});
