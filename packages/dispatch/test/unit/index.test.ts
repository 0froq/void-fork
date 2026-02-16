import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/env";
import type { HeaderRule } from "../../src/headers";

interface RoutingEntry {
  workerName?: string;
  projectId: string;
  ssr?: boolean;
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

function createEnv(options: {
  routing: RoutingEntry;
  assets?: Record<string, { body: string; contentType?: string }>;
  workerResponse?: Response;
}): { env: Env; workerFetch: ReturnType<typeof vi.fn> } {
  const workerFetch = vi.fn(async () => options.workerResponse ?? new Response("worker"));

  const env = {
    ROUTING: {
      get: async () => JSON.stringify(options.routing),
    },
    DISPATCH: {
      get: () => ({ fetch: workerFetch }),
    },
    ASSETS: {
      get: async (key: string) => {
        const object = options.assets?.[key];
        if (!object) return null;
        return {
          body: object.body,
          httpMetadata: { contentType: object.contentType ?? "text/plain" },
        } as unknown as R2ObjectBody;
      },
    },
  } as unknown as Env;

  return { env, workerFetch };
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
