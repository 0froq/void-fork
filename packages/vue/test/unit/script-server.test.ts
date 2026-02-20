import { describe, expect, it } from "vitest";
import { extractTypeDeclarations, scriptServerPlugin } from "../../src/plugin-script-server";

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
  it("strips runtime code from <script server> block", () => {
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

  it("preserves type declarations for <script setup>", () => {
    const p = createPlugin();
    const code = `<script server lang="ts">
import { defineHandler } from "vite-cloud";

interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: "Home" };
});
</script>

<script setup lang="ts">
defineProps<Props>();
</script>

<template><div>{{ title }}</div></template>`;

    const result = p.transform(code, "/project/pages/home.vue");
    expect(result).not.toBeNull();
    // Type declaration is preserved
    expect(result!.code).toContain("interface Props");
    expect(result!.code).toContain("title: string");
    // Runtime code is blanked
    expect(result!.code).not.toContain("defineHandler");
    expect(result!.code).not.toContain("import { defineHandler");
    // The server attribute is stripped so Vue compiler sees a normal <script>
    expect(result!.code).not.toContain("<script server");
    expect(result!.code).toContain('<script lang="ts">');
    expect(result!.code).toContain("</script>");
    // The rest of the SFC is untouched
    expect(result!.code).toContain('<script setup lang="ts">');
    expect(result!.code).toContain("defineProps<Props>();");
  });

  it("preserves multi-line types with brace tracking", () => {
    const p = createPlugin();
    const code = `<script server lang="ts">
import { defineHandler } from "vite-cloud";

export interface User {
  id: number;
  name: string;
  address: {
    city: string;
    zip: string;
  };
}

export const loader = defineHandler(() => {
  return { users: [] };
});
</script>
<template><div /></template>`;

    const result = p.transform(code, "/project/pages/multi.vue");
    expect(result).not.toBeNull();
    expect(result!.code).toContain("export interface User");
    expect(result!.code).toContain("id: number;");
    expect(result!.code).toContain("city: string;");
    expect(result!.code).not.toContain("defineHandler");
  });

  it("preserves import type statements", () => {
    const p = createPlugin();
    const code = `<script server lang="ts">
import type { User } from "../types";
import { defineHandler } from "vite-cloud";

export const loader = defineHandler(() => {
  return { users: [] as User[] };
});
</script>
<template><div /></template>`;

    const result = p.transform(code, "/project/pages/typed-import.vue");
    expect(result).not.toBeNull();
    expect(result!.code).toContain('import type { User } from "../types"');
    expect(result!.code).not.toContain("import { defineHandler");
    expect(result!.code).not.toContain("export const loader");
  });

  it("falls back to newlines when no type declarations exist", () => {
    const p = createPlugin();
    const code = `<script server>
import { defineHandler } from "vite-cloud";

export const loader = defineHandler(() => {
  return { count: 1 };
});
</script>
<template><div>{{ count }}</div></template>`;

    const result = p.transform(code, "/project/pages/no-types.vue");
    expect(result).not.toBeNull();
    // Entire block is replaced with newlines
    expect(result!.code).not.toContain("<script server>");
    expect(result!.code).not.toContain("defineHandler");
    expect(result!.code).toContain("<template>");
  });
});

describe("extractTypeDeclarations", () => {
  it("returns null when no types exist", () => {
    const content = `
import { defineHandler } from "vite-cloud";

export const loader = defineHandler(() => {
  return { count: 1 };
});`;
    expect(extractTypeDeclarations(content)).toBeNull();
  });

  it("keeps interface and blanks runtime", () => {
    const content = `
import { defineHandler } from "vite-cloud";

interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: "Home" };
});`;

    const result = extractTypeDeclarations(content)!;
    expect(result).not.toBeNull();
    expect(result).toContain("interface Props");
    expect(result).toContain("title: string");
    expect(result).not.toContain("defineHandler");
    expect(result).not.toContain("import");
  });

  it("keeps type alias", () => {
    const content = `
type Status = "active" | "inactive";

export const loader = () => ({});`;

    const result = extractTypeDeclarations(content)!;
    expect(result).toContain('type Status = "active" | "inactive"');
    expect(result).not.toContain("export const");
  });

  it("keeps export type", () => {
    const content = `
export type Props = { name: string };

export const loader = () => ({});`;

    const result = extractTypeDeclarations(content)!;
    expect(result).toContain("export type Props = { name: string }");
    expect(result).not.toContain("export const");
  });

  it("tracks nested braces in multi-line types", () => {
    const content = `
interface Props {
  user: {
    name: string;
    address: {
      city: string;
    };
  };
}`;

    const result = extractTypeDeclarations(content)!;
    // Every line of the interface should be kept
    expect(result).toContain("interface Props {");
    expect(result).toContain("city: string;");
    expect(result.trim().endsWith("}")).toBe(true);
  });
});
