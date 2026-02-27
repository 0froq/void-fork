import { defineHandler } from "void";
import { ai } from "void/ai";

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json<{ prompt: string }>();
  return ai.stream("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 512,
  });
});
