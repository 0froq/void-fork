import { describe, expect, it } from "vitest";
import { compileRouteTable, compileWorkerEntry } from "../../src/router/compile";
import type { ScanResult } from "../../src/router/scan";

const testOptions = {
  rou3Path: "/resolved/rou3/index.mjs",
  contextPath: "/resolved/vite-plugin-cloud/runtime/context.mjs",
  responsePath: "/resolved/vite-plugin-cloud/runtime/response.mjs",
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
    };

    const code = compileRouteTable(scan, "/routes", "/middleware", testOptions);

    // Should import rou3 from resolved path
    expect(code).toContain(
      `import { createRouter, addRoute, findRoute } from "/resolved/rou3/index.mjs"`,
    );
    // Should have lazy imports for routes
    expect(code).toContain('import("/routes/api/hello.get.ts")');
    expect(code).toContain('import("/routes/api/users/[id].ts")');
    // Should import middleware eagerly
    expect(code).toContain('import middleware0 from "/middleware/01.logger.ts"');
    // Should create router and add routes
    expect(code).toContain("const router = createRouter()");
    expect(code).toContain('addRoute(router, "GET", "/api/hello"');
    expect(code).toContain('addRoute(router, "", "/api/users/:id"');
    // Should export middleware array
    expect(code).toContain("export const middleware = [middleware0]");
    // Should export matchRoute
    expect(code).toContain("export function matchRoute(method, path)");
  });

  it("handles empty scan result", () => {
    const scan: ScanResult = { routes: [], middleware: [] };
    const code = compileRouteTable(scan, "/routes", "/middleware", testOptions);

    expect(code).toContain("const router = createRouter()");
    expect(code).toContain("export const middleware = []");
  });
});

describe("compileWorkerEntry", () => {
  it("generates valid worker entry code", () => {
    const code = compileWorkerEntry(testOptions);

    expect(code).toContain("import { matchRoute, middleware } from 'virtual:vite-cloud-routes'");
    expect(code).toContain("async fetch(request, rawEnv, executionContext)");
    expect(code).toContain("matchRoute(method, path)");
    expect(code).toContain("convertReturnValue(result)");
    // Should use resolved paths for runtime modules
    expect(code).toContain("/resolved/vite-plugin-cloud/runtime/context.mjs");
    expect(code).toContain("/resolved/vite-plugin-cloud/runtime/response.mjs");
  });
});
