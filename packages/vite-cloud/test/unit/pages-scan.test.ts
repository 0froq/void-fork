import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scanPages, resolveLayoutChain } from "../../src/pages/scan";

const TMP = join(import.meta.dirname, "__tmp_pages_scan__");

function writeFile(relativePath: string, content: string): void {
  const full = join(TMP, "pages", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("scanPages", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, "pages"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns empty result when no pages/ directory exists", async () => {
    rmSync(join(TMP, "pages"), { recursive: true, force: true });
    const result = await scanPages(TMP);
    expect(result).toEqual({ pages: [], layouts: [] });
  });

  it("scans .vue files and produces correct patterns", async () => {
    writeFile("index.vue", "<template><div>Home</div></template>");
    writeFile("about.vue", "<template><div>About</div></template>");
    writeFile("users/index.vue", "<template><div>Users</div></template>");
    writeFile("users/[id].vue", "<template><div>User</div></template>");

    const result = await scanPages(TMP);

    expect(result.pages).toHaveLength(4);

    const home = result.pages.find((p) => p.componentId === "index");
    expect(home).toBeDefined();
    expect(home!.pattern).toBe("/");

    const about = result.pages.find((p) => p.componentId === "about");
    expect(about).toBeDefined();
    expect(about!.pattern).toBe("/about");

    const users = result.pages.find((p) => p.componentId === "users");
    expect(users).toBeDefined();
    expect(users!.pattern).toBe("/users");

    const userId = result.pages.find((p) => p.componentId === "users/[id]");
    expect(userId).toBeDefined();
    expect(userId!.pattern).toBe("/users/:id");
    expect(userId!.params).toEqual(["id"]);
  });

  it("detects companion .server.ts files and extracts methods", async () => {
    writeFile("users/index.vue", "<template><div>Users</div></template>");
    writeFile(
      "users/index.server.ts",
      "export const GET = () => [];\nexport const POST = () => ({});",
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "users");
    expect(page).toBeDefined();
    expect(page!.serverPath).toBe("users/index.server.ts");
    expect(page!.methods).toEqual(["GET", "POST"]);
    expect(page!.hasInlineServer).toBe(false);
  });

  it("detects <script server> blocks in .vue files", async () => {
    writeFile(
      "users/index.vue",
      `<script server>
export const GET = () => [];
</script>
<template><div>Users</div></template>`,
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "users");
    expect(page).toBeDefined();
    expect(page!.hasInlineServer).toBe(true);
    expect(page!.serverPath).toBeNull();
  });

  it("prefers companion .server.ts over <script server>", async () => {
    writeFile(
      "users/index.vue",
      `<script server>
export const GET = () => [];
</script>
<template><div>Users</div></template>`,
    );
    writeFile("users/index.server.ts", "export const GET = () => [];");

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === "users");
    expect(page).toBeDefined();
    expect(page!.serverPath).toBe("users/index.server.ts");
    expect(page!.hasInlineServer).toBe(false);
  });

  it("identifies layout.vue files separately", async () => {
    writeFile("layout.vue", "<template><slot /></template>");
    writeFile("users/layout.vue", "<template><slot /></template>");
    writeFile("index.vue", "<template><div>Home</div></template>");

    const result = await scanPages(TMP);
    expect(result.layouts).toHaveLength(2);

    const root = result.layouts.find((l) => l.directory === "");
    expect(root).toBeDefined();
    expect(root!.filePath).toBe("layout.vue");

    const users = result.layouts.find((l) => l.directory === "users");
    expect(users).toBeDefined();
    expect(users!.filePath).toBe("users/layout.vue");

    // Layouts should not appear as pages
    expect(result.pages.every((p) => !p.componentPath.includes("layout"))).toBe(true);
  });

  it("skips _-prefixed files", async () => {
    writeFile("index.vue", "<template><div>Home</div></template>");
    writeFile("_components/shared.vue", "<template><div>Shared</div></template>");
    writeFile("_hidden.vue", "<template><div>Hidden</div></template>");

    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].componentId).toBe("index");
  });

  it("sorts static before dynamic, catch-all last", async () => {
    writeFile("about.vue", "<template><div /></template>");
    writeFile("[...slug].vue", "<template><div /></template>");
    writeFile("[id].vue", "<template><div /></template>");
    writeFile("index.vue", "<template><div /></template>");

    const result = await scanPages(TMP);
    const patterns = result.pages.map((p) => p.pattern);
    // Static routes first (/about, /), then dynamic (/:id), then catch-all
    expect(patterns.indexOf("/about")).toBeLessThan(patterns.indexOf("/:id"));
    expect(patterns.indexOf("/:id")).toBeLessThan(patterns.indexOf("/**:slug"));
  });

  it("handles .tsx components", async () => {
    writeFile("dashboard.tsx", "export default function Dashboard() { return <div />; }");
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].componentId).toBe("dashboard");
    expect(result.pages[0].pattern).toBe("/dashboard");
  });
});

describe("resolveLayoutChain", () => {
  it("returns correct layout hierarchy", () => {
    const layouts = [
      { directory: "", filePath: "layout.vue" },
      { directory: "users", filePath: "users/layout.vue" },
      { directory: "users/settings", filePath: "users/settings/layout.vue" },
    ];

    const chain = resolveLayoutChain("users/settings/profile", layouts);
    expect(chain).toHaveLength(3);
    expect(chain[0].directory).toBe("");
    expect(chain[1].directory).toBe("users");
    expect(chain[2].directory).toBe("users/settings");
  });

  it("returns only root layout for top-level pages", () => {
    const layouts = [
      { directory: "", filePath: "layout.vue" },
      { directory: "users", filePath: "users/layout.vue" },
    ];

    const chain = resolveLayoutChain("about", layouts);
    expect(chain).toHaveLength(1);
    expect(chain[0].directory).toBe("");
  });

  it("returns empty array when no layouts match", () => {
    const layouts = [{ directory: "admin", filePath: "admin/layout.vue" }];

    const chain = resolveLayoutChain("about", layouts);
    expect(chain).toHaveLength(0);
  });

  it("skips missing intermediate layouts", () => {
    const layouts = [
      { directory: "", filePath: "layout.vue" },
      { directory: "users/settings", filePath: "users/settings/layout.vue" },
    ];

    const chain = resolveLayoutChain("users/settings/profile", layouts);
    expect(chain).toHaveLength(2);
    expect(chain[0].directory).toBe("");
    expect(chain[1].directory).toBe("users/settings");
  });
});
