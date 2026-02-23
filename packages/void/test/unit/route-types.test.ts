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

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void");

    expect(dts).toContain('declare module "void/routes"');
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

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void");

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

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void");

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

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void");

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
    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void");

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

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void");

    // Should have relative path from .void to routes
    expect(dts).toContain("../routes/api/deep/nested");
  });

  it("generates PageActionMap for pages with actions", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: "/users",
            params: [],
            catchAll: false,
            componentPath: "users/index.vue",
            serverPath: "users/index.server.ts",
            hasInlineServer: false,
            methods: ["loader", "action"],
            componentId: "users",
          },
        ],
        layouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void", "/project/pages");

    expect(dts).toContain("interface PageActionMap");
    expect(dts).toContain('"/users"');
    expect(dts).toContain('typeof import("../pages/users/index.server")');
    expect(dts).toContain("body:");
  });

  it("generates params in PageActionMap for dynamic routes", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: "/users/:id",
            params: ["id"],
            catchAll: false,
            componentPath: "users/[id].vue",
            serverPath: "users/[id].server.ts",
            hasInlineServer: false,
            methods: ["loader", "action"],
            componentId: "users/[id]",
          },
        ],
        layouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void", "/project/pages");

    expect(dts).toContain('"/users/:id"');
    expect(dts).toContain("params: { id: string }");
  });

  it("generates server file and typeof import for inline script server pages", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: "/settings",
            params: [],
            catchAll: false,
            componentPath: "settings.vue",
            serverPath: null,
            hasInlineServer: true,
            inlineServerContent: `
import { defineHandler } from "void";
import * as v from "valibot";

export const action = defineHandler.withValidator({
  body: v.object({ theme: v.string() }),
})(async (c, { body }) => {});
`,
            methods: ["loader", "action"],
            componentId: "settings",
          },
        ],
        layouts: [],
      },
    };

    const { dts, serverFiles } = generateRouteTypes(
      scan,
      "/project/routes",
      "/project/.void",
      "/project/pages",
    );

    // Should generate typeof import pointing to the extracted server file
    expect(dts).toContain('"/settings"');
    expect(dts).toContain('typeof import("./server/settings.server")');
    expect(dts).not.toContain("body: Record<string, unknown>");

    // Should produce a server file with the extracted content
    expect(serverFiles).toHaveLength(1);
    expect(serverFiles[0].relativePath).toBe("server/settings.server.ts");
    expect(serverFiles[0].content).toContain("defineHandler.withValidator");
  });

  it("rewrites relative imports in extracted server files", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: "/users",
            params: [],
            catchAll: false,
            componentPath: "users/index.vue",
            serverPath: null,
            hasInlineServer: true,
            inlineServerContent: `
import { defineHandler } from "void";
import { USERS } from "./_data";

export const action = defineHandler(() => {});
`,
            methods: ["action"],
            componentId: "users",
          },
        ],
        layouts: [],
      },
    };

    const { serverFiles } = generateRouteTypes(
      scan,
      "/project/routes",
      "/project/.void",
      "/project/pages",
    );

    expect(serverFiles).toHaveLength(1);
    expect(serverFiles[0].relativePath).toBe("server/users/index.server.ts");
    // Relative import "./_data" should be rewritten to resolve from
    // .void/server/users/ back to pages/users/_data
    expect(serverFiles[0].content).toContain("../../../pages/users/_data");
    expect(serverFiles[0].content).not.toContain('"./_data"');
    // Non-relative imports should be untouched
    expect(serverFiles[0].content).toContain('"void"');
  });

  it("falls back to Record<string, unknown> for inline script server without content", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: "/settings",
            params: [],
            catchAll: false,
            componentPath: "settings.vue",
            serverPath: null,
            hasInlineServer: true,
            // no inlineServerContent
            methods: ["loader", "action"],
            componentId: "settings",
          },
        ],
        layouts: [],
      },
    };

    const { dts, serverFiles } = generateRouteTypes(
      scan,
      "/project/routes",
      "/project/.void",
      "/project/pages",
    );

    expect(dts).toContain("body: Record<string, unknown>");
    expect(serverFiles).toHaveLength(0);
  });

  it("skips pages without action in PageActionMap", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: "/about",
            params: [],
            catchAll: false,
            componentPath: "about.vue",
            serverPath: "about.server.ts",
            hasInlineServer: false,
            methods: ["loader"],
            componentId: "about",
          },
        ],
        layouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void", "/project/pages");

    expect(dts).not.toContain("PageActionMap");
  });

  it("omits PageActionMap when pagesDir is not provided", () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: "/users",
            params: [],
            catchAll: false,
            componentPath: "users/index.vue",
            serverPath: "users/index.server.ts",
            hasInlineServer: false,
            methods: ["loader", "action"],
            componentId: "users",
          },
        ],
        layouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, "/project/routes", "/project/.void");

    expect(dts).not.toContain("PageActionMap");
  });
});
