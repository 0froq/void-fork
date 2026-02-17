import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/env";
import type { HeaderRule } from "../../src/headers";

interface RoutingEntry {
  workerName?: string;
  projectId: string;
  ssr?: boolean;
  revalidate?: number;
  mode?: "spa" | "ssg";
  version?: string;
  headers?: HeaderRule[];
}

// Mock the CF Cache API global
const cacheStore = new Map<string, Response>();
const mockCache = {
  match: async (req: Request) => {
    const cached = cacheStore.get(req.url);
    return cached ? cached.clone() : undefined;
  },
  put: async (req: Request, res: Response) => {
    cacheStore.set(req.url, res.clone());
  },
};

beforeAll(() => {
  vi.stubGlobal("caches", { default: mockCache });
});

beforeEach(() => {
  cacheStore.clear();
});

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
}): { env: Env; workerFetch: ReturnType<typeof vi.fn>; r2Store: Map<string, MockAsset> } {
  const workerFetch = vi.fn(async () => options.workerResponse ?? new Response("worker"));
  const r2Store = new Map<string, MockAsset>();

  // Seed initial assets
  if (options.assets) {
    for (const [key, value] of Object.entries(options.assets)) {
      r2Store.set(key, value);
    }
  }

  const env = {
    ROUTING: {
      get: async () => JSON.stringify(options.routing),
    },
    DISPATCH: {
      get: () => ({ fetch: workerFetch }),
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
    },
  } as unknown as Env;

  return { env, workerFetch, r2Store };
}

describe("dispatch fetch handler", () => {
  it("forwards /api requests to user worker", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1" },
      workerResponse: new Response("api"),
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/api/hello", { method: "GET" }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("api");
  });

  it("serves static files first in SSR mode", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1", ssr: true },
      assets: {
        "proj_1/current/assets/app-abc12345.js": { body: "console.log('asset')" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/assets/app-abc12345.js"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("console.log('asset')");
  });

  it("falls through to SSR worker on non-static miss when ssr is enabled", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1", ssr: true },
      workerResponse: new Response("<html>ssr</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("<html>ssr</html>");
  });

  it("serves prerendered nested html before SSR fallback", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1", ssr: true },
      assets: {
        "proj_1/current/about/index.html": { body: "<html>about</html>", contentType: "text/html" },
      },
      workerResponse: new Response("<html>ssr</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/about"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("<html>about</html>");
  });

  it("keeps SPA index fallback for non-SSR projects", async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: "user-app", projectId: "proj_1" },
      assets: {
        "proj_1/current/index.html": { body: "<html>spa</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(await response.text()).toBe("<html>spa</html>");
  });
});

describe("dispatch static-only routing", () => {
  it("serves SPA with index.html fallback for unknown paths", async () => {
    const { env, workerFetch } = createEnv({
      routing: { projectId: "proj_1", mode: "spa" },
      assets: {
        "proj_1/current/index.html": { body: "<html>SPA</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/dashboard/settings"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>SPA</html>");
  });

  it("serves SSG with nested index.html for clean URLs", async () => {
    const { env, workerFetch } = createEnv({
      routing: { projectId: "proj_1", mode: "ssg" },
      assets: {
        "proj_1/current/about/index.html": { body: "<html>About</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/about"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>About</html>");
  });

  it("serves SSG 404.html with status 404 for unknown paths", async () => {
    const { env, workerFetch } = createEnv({
      routing: { projectId: "proj_1", mode: "ssg" },
      assets: {
        "proj_1/current/404.html": { body: "<html>Not Found</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/nonexistent"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("<html>Not Found</html>");
  });

  it("returns plain 404 for SSG when no 404.html exists", async () => {
    const { env, workerFetch } = createEnv({
      routing: { projectId: "proj_1", mode: "ssg" },
      assets: {},
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/nonexistent"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("serves SSG root index.html for / path", async () => {
    const { env, workerFetch } = createEnv({
      routing: { projectId: "proj_1", mode: "ssg" },
      assets: {
        "proj_1/current/index.html": { body: "<html>Home</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>Home</html>");
  });

  it("serves SSG static file by exact path", async () => {
    const { env, workerFetch } = createEnv({
      routing: { projectId: "proj_1", mode: "ssg" },
      assets: {
        "proj_1/current/styles.css": { body: "body{}", contentType: "text/css" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/styles.css"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body{}");
  });

  it("does not dispatch to worker for /api routes on static deploys", async () => {
    const { env, workerFetch } = createEnv({
      routing: { projectId: "proj_1", mode: "spa" },
      assets: {
        "proj_1/current/index.html": { body: "<html>SPA</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/api/hello"),
      env,
      createCtx(),
    );

    // Static SPA: no worker, so /api falls through to SPA fallback
    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>SPA</html>");
  });
});

describe("custom header rules", () => {
  it("applies header rules to static SPA responses", async () => {
    const { env } = createEnv({
      routing: {
        projectId: "proj_1",
        mode: "spa",
        headers: [{ pattern: "/*", headers: [["X-Frame-Options", "DENY"]] }],
      },
      assets: {
        "proj_1/current/index.html": { body: "<html>SPA</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/"),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("applies header rules to static SSG responses", async () => {
    const { env } = createEnv({
      routing: {
        projectId: "proj_1",
        mode: "ssg",
        headers: [{ pattern: "/*", headers: [["X-Custom", "ssg-value"]] }],
      },
      assets: {
        "proj_1/current/index.html": { body: "<html>SSG</html>", contentType: "text/html" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/"),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Custom")).toBe("ssg-value");
  });

  it("applies header rules to non-SSR worker static responses", async () => {
    const { env } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        headers: [
          {
            pattern: "/assets/*",
            headers: [["Cache-Control", "public, max-age=31536000, immutable"]],
          },
        ],
      },
      assets: {
        "proj_1/current/assets/app.js": { body: "console.log(1)" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/assets/app.js"),
      env,
      createCtx(),
    );

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("does not apply header rules to API worker responses", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        headers: [{ pattern: "/*", headers: [["X-Frame-Options", "DENY"]] }],
      },
      workerResponse: new Response("api response"),
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/api/hello"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("applies header rules to SSR static hit responses", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        headers: [{ pattern: "/assets/*", headers: [["X-Asset", "yes"]] }],
      },
      assets: {
        "proj_1/current/assets/style.css": { body: "body{}", contentType: "text/css" },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/assets/style.css"),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.headers.get("X-Asset")).toBe("yes");
  });

  it("does not apply header rules to SSR worker fallback responses", async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: "user-app",
        projectId: "proj_1",
        ssr: true,
        headers: [{ pattern: "/*", headers: [["X-Custom", "value"]] }],
      },
      workerResponse: new Response("<html>ssr</html>"),
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get("X-Custom")).toBeNull();
  });
});

describe("conditional requests (304)", () => {
  it("returns 304 when If-None-Match matches ETag on fresh response", async () => {
    const { env } = createEnv({
      routing: { projectId: "proj_1", mode: "spa" },
      assets: {
        "proj_1/current/index.html": {
          body: "<html>SPA</html>",
          contentType: "text/html",
          etag: '"abc123"',
        },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/", {
        headers: { "If-None-Match": '"abc123"' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe('"abc123"');
  });

  it("returns 200 when If-None-Match does not match", async () => {
    const { env } = createEnv({
      routing: { projectId: "proj_1", mode: "spa" },
      assets: {
        "proj_1/current/index.html": {
          body: "<html>SPA</html>",
          contentType: "text/html",
          etag: '"abc123"',
        },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/", {
        headers: { "If-None-Match": '"old-etag"' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>SPA</html>");
  });

  it("returns 304 on cache hit when If-None-Match matches", async () => {
    const { env } = createEnv({
      routing: { projectId: "proj_1", mode: "spa", version: "dpl_1" },
      assets: {
        "proj_1/current/index.html": {
          body: "<html>SPA</html>",
          contentType: "text/html",
          etag: '"abc123"',
        },
      },
    });

    // First request populates the edge cache
    await app.fetch(new Request("https://my-app.vitecloud.app/"), env, createCtx());

    // Second request with If-None-Match should return 304 from cache
    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/", {
        headers: { "If-None-Match": '"abc123"' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(304);
  });

  it("includes ETag header on static responses", async () => {
    const { env } = createEnv({
      routing: { projectId: "proj_1", mode: "spa" },
      assets: {
        "proj_1/current/index.html": {
          body: "<html>SPA</html>",
          contentType: "text/html",
          etag: '"my-etag"',
        },
      },
    });

    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/"),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"my-etag"');
  });
});

describe("edge cache versioning", () => {
  it("invalidates cache when routing version changes", async () => {
    const assets = {
      "proj_1/current/index.html": { body: "<html>v1</html>", contentType: "text/html" },
    };

    // First request with version "dpl_1" — cache miss, populates cache
    const { env: env1 } = createEnv({
      routing: { projectId: "proj_1", mode: "spa", version: "dpl_1" },
      assets,
    });
    const res1 = await app.fetch(new Request("https://my-app.vitecloud.app/"), env1, createCtx());
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe("<html>v1</html>");

    // Second request with same version — cache hit (R2 not called again)
    const r2Get = vi.fn(async () => null);
    const env2 = {
      ROUTING: {
        get: async () => JSON.stringify({ projectId: "proj_1", mode: "spa", version: "dpl_1" }),
      },
      DISPATCH: { get: () => ({ fetch: vi.fn() }) },
      ASSETS: { get: r2Get },
    } as unknown as Env;
    const res2 = await app.fetch(new Request("https://my-app.vitecloud.app/"), env2, createCtx());
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe("<html>v1</html>");
    expect(r2Get).not.toHaveBeenCalled();

    // Third request with new version "dpl_2" — cache miss (version changed)
    const { env: env3 } = createEnv({
      routing: { projectId: "proj_1", mode: "spa", version: "dpl_2" },
      assets: {
        "proj_1/current/index.html": { body: "<html>v2</html>", contentType: "text/html" },
      },
    });
    const res3 = await app.fetch(new Request("https://my-app.vitecloud.app/"), env3, createCtx());
    expect(res3.status).toBe(200);
    expect(await res3.text()).toBe("<html>v2</html>");
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
    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/dashboard"),
      env,
      ctx,
    );

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
      new Request("https://my-app.vitecloud.app/dashboard"),
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
      new Request("https://my-app.vitecloud.app/dashboard", {
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
    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/dashboard"),
      env,
      ctx,
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("<html>no-cache</html>");
    // No background write should happen
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
      new Request("https://my-app.vitecloud.app/dashboard"),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get("x-isr-cache")).toBeNull();
    expect(await response.text()).toBe("<html>ssr</html>");
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
    const response = await app.fetch(
      new Request("https://my-app.vitecloud.app/dashboard"),
      env,
      ctx,
    );

    // Should return stale content immediately
    expect(response.headers.get("x-isr-cache")).toBe("STALE");
    expect(await response.text()).toBe("<html>stale</html>");

    // Background revalidation should have been scheduled
    expect((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Wait for background write
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();
  });
});
