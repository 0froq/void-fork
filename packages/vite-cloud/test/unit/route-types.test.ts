import { describe, expect, it } from "vitest";
import { generateRouteTypes } from "../../src/codegen/route-types";
import type { ScanResult } from "../../src/router/scan";

describe("generateRouteTypes", () => {
  it("generates route type declarations for single-method routes", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/hello",
          methods: ["GET"],
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/hello.ts",
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };

    const dts = generateRouteTypes(scan, "/project/routes", "/project/.vite-cloud");

    expect(dts).toContain('declare module "vite-cloud/routes"');
    expect(dts).toContain('"/api/hello"');
    expect(dts).toContain("GET: {");
    expect(dts).toContain('typeof import("../routes/api/hello")');
    expect(dts).toContain("input:");
    expect(dts).toContain("output:");
  });

  it("generates multi-method routes", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/users",
          methods: ["GET", "POST"],
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/users/index.ts",
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };

    const dts = generateRouteTypes(scan, "/project/routes", "/project/.vite-cloud");

    expect(dts).toContain("GET: {");
    expect(dts).toContain("POST: {");
    expect(dts).toContain('typeof import("../routes/api/users/index")');
  });

  it("skips routes with no methods", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/legacy",
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/legacy.ts",
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };

    const dts = generateRouteTypes(scan, "/project/routes", "/project/.vite-cloud");

    expect(dts).not.toContain("/api/legacy");
  });

  it("handles dynamic params in patterns", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/users/:id",
          methods: ["GET"],
          params: ["id"],
          catchAll: false,
          env: null,
          filePath: "api/users/[id].ts",
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };

    const dts = generateRouteTypes(scan, "/project/routes", "/project/.vite-cloud");

    expect(dts).toContain('"/api/users/:id"');
    expect(dts).toContain('typeof import("../routes/api/users/[id]")');
  });

  it("includes Serialize and ExtractInput helper types", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };
    const dts = generateRouteTypes(scan, "/project/routes", "/project/.vite-cloud");

    expect(dts).toContain("type Serialize<T>");
    expect(dts).toContain("type ExtractInput<V>");
    expect(dts).toContain("StandardSchemaV1");
  });

  it("generates correct relative paths", () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: "/api/deep/nested",
          methods: ["GET"],
          params: [],
          catchAll: false,
          env: null,
          filePath: "api/deep/nested.ts",
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [] },
    };

    const dts = generateRouteTypes(scan, "/project/routes", "/project/.vite-cloud");

    // Should have relative path from .vite-cloud to routes
    expect(dts).toContain("../routes/api/deep/nested");
  });
});
