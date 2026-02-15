import { describe, expect, it } from "vitest";
import { compileRouteTable, compileWorkerEntry } from "../../src/router/compile";
import type { ScanResult } from "../../src/router/scan";

const testOptions = {
  honoPath: "/resolved/hono/index.mjs",
  responsePath: "/resolved/vite-cloud/runtime/response.mjs",
  reactRefresh: true,
};

describe("compileRouteTable", () => {
  it("generates valid module code with routes and middleware", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/hello",
          method: "get",
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/hello.get.ts",
        },
        {
          pattern: "/api/users/:id",
          method: "*",
          params: ["id"],
          catchAll: false,
          env: null,
          filePath: "api/users/[id].ts",
        },
      ],
      middleware: [{ order: 1, filePath: "01.logger.ts" }],
      jobs: [{ filePath: "sync.ts", name: "sync", cron: "0 * * * *" }],
    };

    const code = compileRouteTable(scan, "/routes", "/middleware", "/jobs", null, testOptions);

    // Should import Hono from resolved path
    expect(code).toContain(`import { Hono } from "/resolved/hono/index.mjs"`);
    // Should import convertReturnValue
    expect(code).toContain(
      `import { convertReturnValue } from "/resolved/vite-cloud/runtime/response.mjs"`,
    );
    // Should import middleware eagerly
    expect(code).toContain('import middleware0 from "/middleware/01.logger.ts"');
    // Should create Hono app
    expect(code).toContain("const app = new Hono()");
    // Should register middleware
    expect(code).toContain("app.use(middleware0)");
    // Should register routes with correct methods
    expect(code).toContain('app.get("/api/hello"');
    expect(code).toContain('app.all("/api/users/:id"');
    // Should have lazy imports within route handlers
    expect(code).toContain('import("/routes/api/hello.get.ts")');
    expect(code).toContain('import("/routes/api/users/[id].ts")');
    // Should generate scheduled handler for cron jobs
    expect(code).toContain("export async function scheduled(controller, env, ctx)");
    expect(code).toContain('const job0Cron = "0 * * * *"');
    expect(code).toContain('import("/jobs/sync.ts")');
    // Should export app as default
    expect(code).toContain("export default app");
  });

  it("handles empty scan result", () => {
    const scan: ScanResult = { routes: [], middleware: [], jobs: [] };
    const code = compileRouteTable(scan, "/routes", "/middleware", "/jobs", null, testOptions);

    expect(code).toContain("const app = new Hono()");
    expect(code).toContain("export async function scheduled() {}");
    expect(code).toContain("export default app");
  });

  it("adds SSR fallback handler when ssr entry is provided", () => {
    const scan: ScanResult = { routes: [], middleware: [], jobs: [] };
    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/jobs",
      {
        serverEntryPath: "/src/main.ssr.ts",
        clientEntryRelativePath: "src/main.client.tsx",
      },
      testOptions,
    );

    expect(code).toContain("app.notFound(async (c) => {");
    expect(code).toContain("if (!shouldHandleSsrRequest(c))");
    expect(code).toContain("return fetchFromAssets(c)");
    expect(code).toContain('import("/src/main.ssr.ts")');
    expect(code).toContain("return renderSsrResponse(c, mod)");
    expect(code).toContain("return render(c, assetTags)");
    expect(code).toContain('const SSR_CLIENT_ENTRY_ID = "src/main.client.tsx"');
    expect(code).toContain('const SSR_CLIENT_ENTRY_URL = "/src/main.client.tsx"');
    expect(code).toContain('new URL("/.vite/manifest.json", request.url)');
    expect(code).toContain('src="/@vite/client"');
    expect(code).toContain('from "/@react-refresh"');
    expect(code).toContain("__vite_plugin_react_preamble_installed__ = true");
  });
});

describe("compileWorkerEntry", () => {
  it("generates valid worker entry code", () => {
    const code = compileWorkerEntry();

    expect(code).toContain("import app, { scheduled } from 'virtual:vite-cloud-routes'");
    expect(code).toContain("export default { fetch: app.fetch, scheduled }");
  });
});
