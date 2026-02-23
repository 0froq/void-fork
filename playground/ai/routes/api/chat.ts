import { defineHandler } from "void";
import { ai } from "void/ai";

export const POST = defineHandler(async (c) => {
  const { model, messages } = await c.req.json<{
    model: string;
    messages: Array<{ role: string; content: string }>;
  }>();

  return ai.stream(model as any, { messages });
});
