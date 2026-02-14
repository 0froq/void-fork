import { describe, expect, it } from "vitest";
import { compileRouteTable, compileWorkerEntry } from "../../src/router/compile";
import type { ScanResult } from "../../src/router/scan";

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

    const code = compileRouteTable(scan, "/routes", "/middleware");

    // Should import rou3
    expect(code).toContain("import { createRouter, addRoute, findRoute } from 'rou3'");
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
    const code = compileRouteTable(scan, "/routes", "/middleware");

    expect(code).toContain("const router = createRouter()");
    expect(code).toContain("export const middleware = []");
  });
});

describe("compileWorkerEntry", () => {
  it("generates valid worker entry code", () => {
    const code = compileWorkerEntry();

    expect(code).toContain("import { matchRoute, middleware } from 'virtual:vite-cloud-routes'");
    expect(code).toContain("async fetch(request, rawEnv, executionContext)");
    expect(code).toContain("matchRoute(method, path)");
    expect(code).toContain("convertReturnValue(result)");
  });
});
