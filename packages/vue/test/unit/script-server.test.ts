import { describe, expect, it } from "vitest";
import { scriptServerPlugin } from "../../src/plugin-script-server";

const PAGES_DIR = "/project/pages";

function createPlugin() {
  const plugin = scriptServerPlugin(PAGES_DIR);
  return {
    transform: (plugin as any).transform.handler.bind(plugin),
    resolveId: (plugin as any).resolveId.handler.bind(plugin),
    load: (plugin as any).load.handler.bind(plugin),
  };
}

describe("scriptServerPlugin", () => {
  it("strips <script server> block and returns cleaned SFC", () => {
    const p = createPlugin();
    const code = `<script server>
export const loader = () => ({ users: [] });
</script>
<template><div>Users</div></template>
<script setup>
const msg = "hello";
</script>`;

    const result = p.transform(code, "/project/pages/users.vue");
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain("<script server>");
    expect(result!.code).not.toContain("export const loader");
    expect(result!.code).toContain("<template><div>Users</div></template>");
    expect(result!.code).toContain("<script setup>");
  });

  it("resolves ?server queries for files with extracted blocks", () => {
    const p = createPlugin();
    // First, transform to extract
    p.transform(
      "<script server>\nexport const loader = () => [];\n</script>\n<template><div /></template>",
      "/project/pages/users.vue",
    );

    const resolved = p.resolveId("/project/pages/users.vue?server");
    expect(resolved).toBe("\0/project/pages/users.vue?server");
  });

  it("loads the extracted server code", () => {
    const p = createPlugin();
    p.transform(
      "<script server>\nexport const loader = () => [];\n</script>\n<template><div /></template>",
      "/project/pages/users.vue",
    );

    const code = p.load("\0/project/pages/users.vue?server");
    expect(code).toContain("export const loader");
  });

  it("passes through files without <script server> unchanged", () => {
    const p = createPlugin();
    const code = "<template><div>No server</div></template>";
    const result = p.transform(code, "/project/pages/about.vue");
    expect(result).toBeUndefined();
  });

  it("ignores files outside pages/", () => {
    const p = createPlugin();
    const code =
      "<script server>\nexport const loader = () => [];\n</script>\n<template><div /></template>";
    const result = p.transform(code, "/project/src/App.vue");
    expect(result).toBeUndefined();
  });

  it("does not resolve ?server for files without extracted blocks", () => {
    const p = createPlugin();
    const resolved = p.resolveId("/project/pages/unknown.vue?server");
    expect(resolved).toBeUndefined();
  });

  it("handles <script server lang='ts'>", () => {
    const p = createPlugin();
    const code = `<script server lang="ts">
export const loader = () => ({ count: 42 });
</script>
<template><div>{{ count }}</div></template>`;

    const result = p.transform(code, "/project/pages/typed.vue");
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain("export const loader");

    // Should be loadable
    p.resolveId("/project/pages/typed.vue?server");
    const loaded = p.load("\0/project/pages/typed.vue?server");
    expect(loaded).toContain("export const loader");
  });
});
