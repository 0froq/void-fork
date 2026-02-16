import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { defineHandler, defineMiddleware } from "../../src/runtime/handler";
import { convertReturnValue } from "../../src/runtime/response";

/**
 * Helper that mimics the generated code pattern in compile.ts:
 *   return convertReturnValue(await mod.default(c))
 */
function createApp(handler: (c: any) => unknown) {
  const app = new Hono();
  app.get("/test", async (c) => {
    return convertReturnValue(await handler(c));
  });
  return app;
}

function req() {
  return new Request("http://localhost/test");
}

describe("defineHandler", () => {
  it("single handler (backwards compat)", async () => {
    const handler = defineHandler((_c) => {
      return { ok: true };
    });
    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("middleware + handler execution order", async () => {
    const order: string[] = [];

    const m1 = defineMiddleware(async (c, next) => {
      order.push("m1-before");
      await next();
      order.push("m1-after");
    });

    const m2 = defineMiddleware(async (c, next) => {
      order.push("m2-before");
      await next();
      order.push("m2-after");
    });

    const handler = defineHandler(m1, m2, (_c) => {
      order.push("handler");
      return { data: "ok" };
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "ok" });
    expect(order).toEqual(["m1-before", "m2-before", "handler", "m2-after", "m1-after"]);
  });

  it("middleware short-circuit (no next())", async () => {
    const m1 = defineMiddleware(async (c, _next) => {
      return c.json({ error: "unauthorized" }, 401);
    });

    const handler = defineHandler(m1, () => {
      throw new Error("should not be called");
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("post-processing middleware adds headers", async () => {
    const addHeader = defineMiddleware(async (c, next) => {
      await next();
      c.res.headers.set("X-Custom", "added");
    });

    const handler = defineHandler(addHeader, () => {
      return { data: "hello" };
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Custom")).toBe("added");
    expect(await res.json()).toEqual({ data: "hello" });
  });

  it("handler returning Response passes through", async () => {
    const handler = defineHandler(() => {
      return new Response("raw", { status: 201 });
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("raw");
  });

  it("handler returning null → 204", async () => {
    const handler = defineHandler(() => {
      return null;
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(204);
  });

  it("raw Hono middleware (not wrapped with defineMiddleware)", async () => {
    const order: string[] = [];

    const rawMiddleware: MiddlewareHandler = async (c, next) => {
      order.push("raw-before");
      c.res.headers.set("X-Raw", "yes");
      await next();
      order.push("raw-after");
    };

    const handler = defineHandler(rawMiddleware, (_c) => {
      order.push("handler");
      return { ok: true };
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("X-Raw")).toBe("yes");
    expect(order).toEqual(["raw-before", "handler", "raw-after"]);
  });

  it("mixed raw Hono middleware and defineMiddleware", async () => {
    const order: string[] = [];

    const rawMiddleware: MiddlewareHandler = async (_c, next) => {
      order.push("raw");
      await next();
    };

    const wrapped = defineMiddleware(async (_c, next) => {
      order.push("wrapped");
      await next();
    });

    const handler = defineHandler(rawMiddleware, wrapped, (_c) => {
      order.push("handler");
      return { done: true };
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });
    expect(order).toEqual(["raw", "wrapped", "handler"]);
  });

  it("raw Hono middleware short-circuits", async () => {
    const guard: MiddlewareHandler = async (c, _next) => {
      return c.text("forbidden", 403);
    };

    const handler = defineHandler(guard, () => {
      throw new Error("should not be called");
    });

    const app = createApp(handler);
    const res = await app.request(req());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
  });

  it("middleware error propagates", async () => {
    const failing = defineMiddleware(async () => {
      throw new Error("middleware boom");
    });

    const handler = defineHandler(failing, () => {
      return { ok: true };
    });

    const app = createApp(handler);
    // Hono catches thrown errors and returns a 500 response
    const res = await app.request(req());
    expect(res.status).toBe(500);
  });
});
