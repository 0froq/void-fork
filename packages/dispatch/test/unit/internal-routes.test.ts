import { describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/env";

vi.stubGlobal("caches", {
  default: {
    match: async () => undefined,
    put: async () => {},
    delete: async () => false,
  },
});

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function createEnv(): Env {
  const workerFetch = vi.fn(async () => new Response("worker"));
  return {
    ROUTING: {
      get: async () => JSON.stringify({ workerName: "user-app", projectId: "proj_1" }),
    },
    DISPATCH: {
      get: vi.fn(() => ({ fetch: workerFetch })),
    },
    ISR_CACHE: {
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async () => {},
      delete: async () => {},
    },
    ANALYTICS: {
      writeDataPoint: vi.fn(),
    },
  } as unknown as Env;
}

describe("internal route blocking", () => {
  it("blocks GET /__scheduled with 404", async () => {
    const response = await app.fetch(
      new Request("https://my-app.void.app/__scheduled"),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("blocks POST /__scheduled with 404", async () => {
    const response = await app.fetch(
      new Request("https://my-app.void.app/__scheduled", { method: "POST" }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it("blocks POST /__queue with 404", async () => {
    const response = await app.fetch(
      new Request("https://my-app.void.app/__queue", { method: "POST" }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it("blocks POST /__void/migrate with 404", async () => {
    const response = await app.fetch(
      new Request("https://my-app.void.app/__void/migrate", { method: "POST" }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it("does not block normal paths", async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request("https://my-app.void.app/normal-path"),
      env,
      createCtx(),
    );
    // Should proceed past the internal route check — the response comes from the worker mock
    expect(response.status).not.toBe(404);
    expect(await response.text()).toContain("worker");
  });
});
