import { Hono } from "hono";
import type { ProxyEnv } from "./types";

const GATEWAY_ID = "void";

const ai = new Hono<ProxyEnv>();

ai.post("/run", async (c) => {
  const body = c.get("body");
  const projectId = c.get("projectId");

  if (!body.model) {
    return c.json({ error: "model required" }, 400);
  }

  const options = {
    ...(body.options ?? {}),
    gateway: { id: GATEWAY_ID, metadata: { projectId } },
  };

  try {
    const result = await (c.env.AI as any).run(body.model, body.inputs, options);

    if (result instanceof ReadableStream) {
      return new Response(result, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI inference error:", message);
    return c.json({ error: "inference error" }, 502);
  }
});

ai.post("/models", async (c) => {
  const body = c.get("body");
  try {
    const result = await (c.env.AI as any).models(body.inputs);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI inference error:", message);
    return c.json({ error: "inference error" }, 502);
  }
});

ai.post("/toMarkdown", async (c) => {
  const body = c.get("body");
  try {
    const result = await (c.env.AI as any).toMarkdown(body.inputs, body.options);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI inference error:", message);
    return c.json({ error: "inference error" }, 502);
  }
});

export { ai };
