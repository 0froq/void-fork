import { defineHandler } from "void";
import { ai } from "void/ai";

export const GET = defineHandler(async (c) => {
  const task = c.req.query("task");
  const models = await ai.models(task ? { task } : undefined);
  return c.json(models);
});
