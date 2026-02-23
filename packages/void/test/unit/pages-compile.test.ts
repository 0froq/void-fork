import { describe, expect, it } from "vitest";
import { compileRouteTable, type PagesCompileOptions } from "../../src/router/compile";
import type { ScanResult } from "../../src/router/scan";

const testOptions = {
  honoPath: "/resolved/hono/index.mjs",
  responsePath: "/resolved/void/runtime/response.mjs",
  reactRefresh: false,
  auth: null,
};

const pagesOptions: PagesCompileOptions = {
  pagesDir: "/project/pages",
  protocolPath: "/resolved/void/pages/protocol.mjs",
  clientEntryId: "virtual:void-pages-client",
};

function makeScan(pages: ScanResult["pages"]): ScanResult {
  return {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages,
  };
}

describe("compileRouteTable with pages", () => {
  it("imports handlePageGet and handlePageMutation from protocol", () => {
    const scan = makeScan({
      pages: [
        {
          pattern: "/",
          params: [],
          catchAll: false,
          componentPath: "index.vue",
          serverPath: null,
          hasInlineServer: false,
          methods: [],
          componentId: "index",
        },
      ],
      layouts: [],
    });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain(
      `import { handlePageGet, handlePageMutation } from "/resolved/void/pages/protocol.mjs"`,
    );
  });

  it("imports renderPage from virtual module", () => {
    const scan = makeScan({
      pages: [
        {
          pattern: "/",
          params: [],
          catchAll: false,
          componentPath: "index.vue",
          serverPath: null,
          hasInlineServer: false,
          methods: [],
          componentId: "index",
        },
      ],
      layouts: [],
    });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain(`import { renderPage } from "virtual:void-pages-renderer"`);
  });

  it("registers GET handler for page without server module", () => {
    const scan = makeScan({
      pages: [
        {
          pattern: "/about",
          params: [],
          catchAll: false,
          componentPath: "about.vue",
          serverPath: null,
          hasInlineServer: false,
          methods: [],
          componentId: "about",
        },
      ],
      layouts: [],
    });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain('app.get("/about"');
    expect(code).toContain('handlePageGet(undefined, c, "about", renderPage, getPagesAssetTags)');
  });

  it("generates lazy loader for companion .server.ts", () => {
    const scan = makeScan({
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
    });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    // Lazy loader
    expect(code).toContain("let _pmod_users;");
    expect(code).toContain("async function _pload_users()");
    expect(code).toContain('import("/project/pages/users/index.server.ts")');

    // GET handler uses loader
    expect(code).toContain('app.get("/users"');
    expect(code).toContain("mod.loader, c");

    // Action mutation handler (POST, PUT, PATCH, DELETE)
    expect(code).toContain('app.on(["POST", "PUT", "PATCH", "DELETE"], "/users"');
    expect(code).toContain("handlePageMutation(mod.action, mod.loader");
  });

  it("uses ?server virtual module for inline <script server>", () => {
    const scan = makeScan({
      pages: [
        {
          pattern: "/contact",
          params: [],
          catchAll: false,
          componentPath: "contact.vue",
          serverPath: null,
          hasInlineServer: true,
          methods: [],
          componentId: "contact",
        },
      ],
      layouts: [],
    });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain('import("/project/pages/contact.vue?server")');
  });

  it("generates catch-all for SPA navigation", () => {
    const scan = makeScan({
      pages: [
        {
          pattern: "/",
          params: [],
          catchAll: false,
          componentPath: "index.vue",
          serverPath: null,
          hasInlineServer: false,
          methods: [],
          componentId: "index",
        },
      ],
      layouts: [],
    });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain("app.notFound(");
    // Should skip API routes
    expect(code).toContain('path.startsWith("/api/")');
  });

  it("does not generate page code when pages is null", () => {
    const scan = makeScan({ pages: [], layouts: [] });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      null,
    );

    expect(code).not.toContain("handlePageGet");
    expect(code).not.toContain("renderPage");
  });

  it("does not generate page code when pages array is empty", () => {
    const scan = makeScan({ pages: [], layouts: [] });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).not.toContain("handlePageGet");
    expect(code).not.toContain("renderPage");
  });

  it("generates asset tags function for production manifest", () => {
    const scan = makeScan({
      pages: [
        {
          pattern: "/",
          params: [],
          catchAll: false,
          componentPath: "index.vue",
          serverPath: null,
          hasInlineServer: false,
          methods: [],
          componentId: "index",
        },
      ],
      layouts: [],
    });

    const code = compileRouteTable(
      scan,
      "/routes",
      "/middleware",
      "/crons",
      "/queues",
      null,
      testOptions,
      pagesOptions,
    );

    expect(code).toContain("getPagesAssetTags");
    expect(code).toContain("loadPagesManifest");
    expect(code).toContain("getPagesDevClientTags");
  });
});
