import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/env";

// Mock caches.default (CF edge cache) with a Map-backed store
const edgeCacheStore = new Map<string, Response>();
vi.stubGlobal("caches", {
  default: {
    match: async (req: Request) => {
      const res = edgeCacheStore.get(req.url);
      return res ? res.clone() : undefined;
    },
    put: async (req: Request, res: Response) => {
      edgeCacheStore.set(req.url, res.clone());
    },
    delete: async (req: Request) => {
      return edgeCacheStore.delete(req.url);
    },
  },
});

beforeEach(() => {
  edgeCacheStore.clear();
});

interface RoutingEntry {
  workerName: string;
  projectId: string;
  userId?: string;
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
}

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

interface MockAsset {
  body: string;
  contentType?: string;
  etag?: string;
  customMetadata?: Record<string, string>;
}

function createEnv(options: {
  routing: RoutingEntry;
  assets?: Record<string, MockAsset>;
  workerResponse?: Response;
  workerFetchImpl?: () => Promise<Response>;
}): {
  env: Env;
  workerFetch: ReturnType<typeof vi.fn>;
  dispatchGet: ReturnType<typeof vi.fn>;
  r2Store: Map<string, MockAsset>;
  analyticsWrites: unknown[];
} {
  const workerFetch = vi.fn(
    async () => options.workerFetchImpl?.() ?? options.workerResponse ?? new Response("worker"),
  );
  const r2Store = new Map<string, MockAsset>();
  const analyticsWrites: unknown[] = [];

  // Seed initial assets (R2 — used for ISR cache only)
  if (options.assets) {
    for (const [key, value] of Object.entries(options.assets)) {
      r2Store.set(key, value);
    }
  }

  const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

  const env = {
    ROUTING: {
      get: async () => JSON.stringify(options.routing),
    },
    DISPATCH: {
      get: dispatchGet,
    },
    ASSETS: {
      get: async (key: string) => {
        const object = r2Store.get(key);
        if (!object) return null;
        return {
          body: object.body,
          httpMetadata: { contentType: object.contentType ?? "text/plain" },
          httpEtag: object.etag ?? `"${key}"`,
          customMetadata: object.customMetadata,
        } as unknown as R2ObjectBody;
      },
      put: async (key: string, body: any, opts?: any) => {
        const text = typeof body === "string" ? body : await new Response(body).text();
        r2Store.set(key, {
          body: text,
          contentType: opts?.httpMetadata?.contentType,
          customMetadata: opts?.customMetadata,
        });
      },
      delete: async (key: string) => {
        r2Store.delete(key);
      },
    },
    ANALYTICS: {
      writeDataPoint: (data: unknown) => analyticsWrites.push(data),
    },
  } as unknown as Env;

  return { env, workerFetch, dispatchGet, r2Store, analyticsWrites };
}

describe("dispatch fetch handler", () => {
  it("forwards /api requests to user worker", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1" },
      workerResponse: new Response("api"),
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/api/hello", { method: "GET" }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("api");
  });

  it("dispatches SSR requests to worker", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1", ssr: true },
      workerResponse: new Response("<html>ssr</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("<html>ssr</html>");
  });

  it("dispatches non-SSR requests to worker", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1" },
      workerResponse: new Response("ok"),
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("ok");
  });
});

describe("custom domain routing", () => {
  it("routes custom domain via domain: KV key", async () => {
    const workerFetch = vi.fn(async () => new Response("custom-domain-api"));
    const routing: RoutingEntry = { workerName: "user-app", projectId: "proj_1" };

    const env = {
      ROUTING: {
        get: async (key: string) => {
          if (key === "domain:app.example.com") return JSON.stringify(routing);
          return null;
        },
      },
      DISPATCH: {
        get: () => ({ fetch: workerFetch }),
      },
      ASSETS: {
        get: async () => null,
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request("https://app.example.com/api/hello"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("custom-domain-api");
  });

  it("returns 404 for unknown hostname", async () => {
    const env = {
      ROUTING: {
        get: async () => null,
      },
      DISPATCH: {
        get: () => ({ fetch: vi.fn() }),
      },
      ASSETS: {
        get: async () => null,
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(new Request("https://unknown.example.com/"), env, createCtx());

    expect(response.status).toBe(404);
  });
});

describe("ISR (stale-while-revalidate)", () => {
  it("caches worker response in R2 on first ISR request", async () => {
    const { env, workerFetch, r2Store } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response("<html>rendered</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request("https://my-app.void.app/dashboard"), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>rendered</html>");

    // Wait for background write
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(r2Store.has("proj_1/isr/dashboard")).toBe(true);
  });

  it("serves from ISR cache on second request (no worker call)", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      assets: {
        "proj_1/isr/dashboard": {
          body: "<html>cached</html>",
          customMetadata: {
            status: "200",
            createdAt: String(Date.now()),
            ttl: "60",
            headers: JSON.stringify({ "Content-Type": "text/html" }),
          },
        },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-isr-cache")).toBe("HIT");
    expect(await response.text()).toBe("<html>cached</html>");
  });

  it("bypasses ISR cache when Cookie header is present", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      assets: {
        "proj_1/isr/dashboard": {
          body: "<html>cached</html>",
          customMetadata: {
            status: "200",
            createdAt: String(Date.now()),
            ttl: "60",
            headers: JSON.stringify({ "Content-Type": "text/html" }),
          },
        },
      },
      workerResponse: new Response("<html>personalized</html>"),
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/dashboard", {
        headers: { Cookie: "session=abc" },
      }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get("x-isr-cache")).toBeNull();
    expect(await response.text()).toBe("<html>personalized</html>");
  });

  it("does not cache when x-revalidate: 0 opt-out", async () => {
    const { env, workerFetch, r2Store } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response("<html>no-cache</html>", {
        headers: { "x-revalidate": "0" },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request("https://my-app.void.app/dashboard"), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("<html>no-cache</html>");
    // No waitUntil calls — analytics is sync, no userId for queue, no ISR cache write
    expect((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(r2Store.has("proj_1/isr/dashboard")).toBe(false);
  });

  it("SSR without revalidate works unchanged", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
      },
      workerResponse: new Response("<html>ssr</html>"),
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get("x-isr-cache")).toBeNull();
    expect(await response.text()).toBe("<html>ssr</html>");
  });

  it("sets ISR-managed headers on cache-miss response", async () => {
    const { env } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response("<html>rendered</html>", {
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "private, no-store", // Worker's raw header should be overridden
        },
      }),
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/dashboard"),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-isr-cache")).toBe("MISS");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, max-age=0, must-revalidate",
    );
  });

  it("deletes R2 entry when background revalidation gets x-revalidate: 0", async () => {
    const { env, workerFetch, r2Store } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      assets: {
        "proj_1/isr/dashboard": {
          body: "<html>stale</html>",
          customMetadata: {
            status: "200",
            createdAt: String(Date.now() - 120 * 1000),
            ttl: "60",
            headers: JSON.stringify({ "Content-Type": "text/html" }),
          },
        },
      },
      workerResponse: new Response("<html>opt-out</html>", {
        headers: { "x-revalidate": "0" },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request("https://my-app.void.app/dashboard"), env, ctx);

    expect(response.headers.get("x-isr-cache")).toBe("STALE");

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();
    // R2 entry should be deleted after x-revalidate: 0
    expect(r2Store.has("proj_1/isr/dashboard")).toBe(false);
  });

  it("revalidates stale entry in background and returns stale content", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      assets: {
        "proj_1/isr/dashboard": {
          body: "<html>stale</html>",
          customMetadata: {
            status: "200",
            createdAt: String(Date.now() - 120 * 1000), // 2 minutes ago, TTL is 60s
            ttl: "60",
            headers: JSON.stringify({ "Content-Type": "text/html" }),
          },
        },
      },
      workerResponse: new Response("<html>fresh</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request("https://my-app.void.app/dashboard"), env, ctx);

    // Should return stale content immediately
    expect(response.headers.get("x-isr-cache")).toBe("STALE");
    expect(await response.text()).toBe("<html>stale</html>");

    // Background revalidation + edge cache put
    expect((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    // Wait for background write
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it("serves from edge cache on repeat ISR request (no R2 read)", async () => {
    // Pre-populate edge cache
    edgeCacheStore.set(
      "https://my-app.void.app/dashboard",
      new Response("<html>edge</html>", {
        headers: { "x-isr-cache": "HIT", "Content-Type": "text/html" },
      }),
    );

    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-isr-cache")).toBe("HIT");
    expect(await response.text()).toBe("<html>edge</html>");
  });

  it("populates edge cache after R2 hit", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        revalidate: 60,
      },
      assets: {
        "proj_1/isr/dashboard": {
          body: "<html>r2-cached</html>",
          customMetadata: {
            status: "200",
            createdAt: String(Date.now()),
            ttl: "60",
            headers: JSON.stringify({ "Content-Type": "text/html" }),
          },
        },
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request("https://my-app.void.app/dashboard"), env, ctx);

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.headers.get("x-isr-cache")).toBe("HIT");
    expect(await response.text()).toBe("<html>r2-cached</html>");

    // Wait for edge cache population
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(edgeCacheStore.has("https://my-app.void.app/dashboard")).toBe(true);
  });
});

describe("suspension check", () => {
  it("returns 429 when project is suspended", async () => {
    const { env } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        suspended: "requests_exceeded",
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.void.app/api/hello"),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.error).toBe("usage limit exceeded");
    expect(body.reason).toBe("requests_exceeded");
  });
});

describe("custom limits", () => {
  it("passes limits to DISPATCH.get for API routes", async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        limits: { cpuMs: 10, subRequests: 50 },
      },
      workerResponse: new Response("api"),
    });

    await app.fetch(new Request("https://my-app.void.app/api/hello"), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      "user-app",
      {},
      { limits: { cpuMs: 10, subRequests: 50 } },
    );
  });

  it("does not pass limits when routing has no limits", async () => {
    const { env, dispatchGet } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1" },
      workerResponse: new Response("api"),
    });

    await app.fetch(new Request("https://my-app.void.app/api/hello"), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith("user-app");
  });

  it("returns 429 when worker exceeds CPU limit", async () => {
    const workerFetch = vi.fn(async () => {
      throw new Error("Worker exceeded CPU time limit");
    });
    const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

    const env = {
      ROUTING: {
        get: async () =>
          JSON.stringify({
            workerName: "user-app",
            projectId: "proj_1",
            limits: { cpuMs: 10 },
          }),
      },
      DISPATCH: { get: dispatchGet },
      ASSETS: { get: async () => null },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request("https://my-app.void.app/api/hello"),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("CPU limit exceeded");
  });

  it("passes limits to DISPATCH.get for SSR routes", async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        limits: { cpuMs: 30, subRequests: 50 },
      },
      workerResponse: new Response("<html>ssr</html>"),
    });

    await app.fetch(new Request("https://my-app.void.app/dashboard"), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      "user-app",
      {},
      { limits: { cpuMs: 30, subRequests: 50 } },
    );
  });
});

describe("hashed asset caching", () => {
  it("serves hashed asset from edge cache on hit", async () => {
    const routing: RoutingEntry = {
      workerName: "test-worker",
      projectId: "proj-1",
      hashedAssetsPrefix: "assets",
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response("asset-body") });
    const ctx = createCtx();

    const url = "https://test.void.app/assets/main-abc123.js";

    // First request — cache miss, hits worker
    const res1 = await app.fetch(new Request(url), env, ctx);
    expect(res1.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(res1.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

    // Wait for background cache.put
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request — cache hit, worker NOT invoked
    const ctx2 = createCtx();
    const res2 = await app.fetch(new Request(url), env, ctx2);
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // still 1
  });

  it("bypasses stale cache entry without immutable header", async () => {
    // Simulate pre-existing Workers Assets cache entry (no immutable header)
    edgeCacheStore.set(
      "https://test.void.app/assets/stale.js",
      new Response("stale", {
        headers: { "Cache-Control": "public, max-age=0, must-revalidate" },
      }),
    );

    const routing: RoutingEntry = {
      workerName: "test-worker",
      projectId: "proj-1",
      hashedAssetsPrefix: "assets",
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response("fresh") });
    const ctx = createCtx();

    const res = await app.fetch(new Request("https://test.void.app/assets/stale.js"), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // bypassed stale entry, hit worker
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("does not cache non-hashed asset paths", async () => {
    const routing: RoutingEntry = {
      workerName: "test-worker",
      projectId: "proj-1",
      hashedAssetsPrefix: "assets",
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response("page") });
    const ctx = createCtx();

    // Request for a non-hashed path
    const res = await app.fetch(new Request("https://test.void.app/about"), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Second request — should still hit worker (no caching)
    const ctx2 = createCtx();
    await app.fetch(new Request("https://test.void.app/about"), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it("skips cache for non-GET requests to hashed paths", async () => {
    const routing: RoutingEntry = {
      workerName: "test-worker",
      projectId: "proj-1",
      hashedAssetsPrefix: "assets",
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response("ok") });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request("https://test.void.app/assets/main.js", { method: "POST" }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    // Should not write to cache
    expect(edgeCacheStore.size).toBe(0);
  });

  it("does not cache non-ok worker responses", async () => {
    const routing: RoutingEntry = {
      workerName: "test-worker",
      projectId: "proj-1",
      hashedAssetsPrefix: "assets",
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response("not found", { status: 404 }),
    });
    const ctx = createCtx();

    const res = await app.fetch(new Request("https://test.void.app/assets/missing.js"), env, ctx);
    expect(res.status).toBe(404);
    expect(edgeCacheStore.size).toBe(0);
  });

  it("skips caching when hashedAssetsPrefix is not set", async () => {
    const routing: RoutingEntry = {
      workerName: "test-worker",
      projectId: "proj-1",
      // no hashedAssetsPrefix
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response("ok") });
    const ctx = createCtx();

    await app.fetch(new Request("https://test.void.app/assets/main.js"), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Second request — still hits worker (no caching)
    const ctx2 = createCtx();
    await app.fetch(new Request("https://test.void.app/assets/main.js"), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it("works with custom prefix like _nuxt", async () => {
    const routing: RoutingEntry = {
      workerName: "test-worker",
      projectId: "proj-1",
      hashedAssetsPrefix: "_nuxt",
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response("nuxt-asset") });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request("https://test.void.app/_nuxt/entry.abc123.js"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });
});
