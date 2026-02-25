import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { compile } from "./compile";
import type { CompileOptions } from "./compile";
import { extractScript } from "./extract-script";
import { emitReactComponent, emitReactComponentWithIslands } from "./emit-react";
import { emitSolidComponent, emitSolidComponentWithIslands } from "./emit-solid";
import { emitSvelteComponent, emitSvelteComponentWithIslands } from "./emit-svelte";
import { emitVueComponent, emitVueComponentWithIslands } from "./emit-vue";

type FrameworkAdapter = "vue" | "react" | "svelte" | "solid";

const ADAPTER_PLUGIN_NAMES: Record<string, FrameworkAdapter> = {
  "void-vue:pages": "vue",
  "void-react:pages": "react",
  "void-svelte:pages": "svelte",
  "void-solid:pages": "solid",
};

const SVELTE_VIRTUAL_PREFIX = "/@void-md-svelte/";
const SOLID_VIRTUAL_PREFIX = "/@void-md-solid/";

interface MdPage {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  headings: { depth: number; slug: string; text: string }[];
}

export interface MarkdownOptions {
  shiki?: CompileOptions["shiki"];
}

export function voidMarkdown(options?: MarkdownOptions): Plugin[] {
  let adapter: FrameworkAdapter | null = null;
  let mdPages: MdPage[] = [];
  let root = "";
  const svelteModules = new Map<string, string>();
  const solidModules = new Map<string, string>();

  function createVirtualModuleId(
    prefix: string,
    importerId: string,
    source: string,
    extension: string,
  ): string {
    const encoded = Buffer.from(importerId).toString("base64url");
    const hash = createHash("sha1").update(source).digest("hex").slice(0, 8);
    return `${prefix}${encoded}.${hash}.${extension}`;
  }

  async function scanMdPages(): Promise<MdPage[]> {
    const pagesDir = join(root, "pages");
    if (!existsSync(pagesDir)) return [];

    const mdFiles = await glob("**/*.md", { cwd: pagesDir });
    const pages = await Promise.all(
      mdFiles.map(async (file) => {
        const content = readFileSync(join(pagesDir, file), "utf-8");
        const { body } = extractScript(content);
        const result = await compile(body, { shiki: options?.shiki });
        const routePath =
          "/" +
          file
            .replace(/\.md$/, "")
            .replace(/\/index$/, "")
            .replace(/^index$/, "");
        return {
          path: routePath || "/",
          title: result.title,
          frontmatter: result.frontmatter,
          headings: result.headings,
        };
      }),
    );
    return pages.sort((a, b) => a.path.localeCompare(b.path));
  }

  return [
    {
      name: "void-md",
      enforce: "pre",

      configResolved(config: ResolvedConfig) {
        root = config.root;
        for (const plugin of config.plugins) {
          const match = ADAPTER_PLUGIN_NAMES[plugin.name];
          if (match) {
            adapter = match;
            break;
          }
        }
        if (!adapter) {
          throw new Error(
            "[void-md] No framework adapter detected. Install @void-x/vue, @void-x/react, @void-x/svelte, or @void-x/solid.",
          );
        }
      },

      async buildStart() {
        svelteModules.clear();
        solidModules.clear();
        mdPages = await scanMdPages();
      },

      configureServer(server: ViteDevServer) {
        server.watcher.on("change", async (file: string) => {
          if (file.endsWith(".md") && file.includes("/pages/")) {
            mdPages = await scanMdPages();
            const mod = server.moduleGraph.getModuleById("\0void-md-pages");
            if (mod) server.moduleGraph.invalidateModule(mod);
          }
        });
        server.watcher.on("add", async (file: string) => {
          if (file.endsWith(".md") && file.includes("/pages/")) {
            mdPages = await scanMdPages();
            const mod = server.moduleGraph.getModuleById("\0void-md-pages");
            if (mod) server.moduleGraph.invalidateModule(mod);
          }
        });
        server.watcher.on("unlink", async (file: string) => {
          if (file.endsWith(".md") && file.includes("/pages/")) {
            mdPages = await scanMdPages();
            const mod = server.moduleGraph.getModuleById("\0void-md-pages");
            if (mod) server.moduleGraph.invalidateModule(mod);
          }
        });
      },

      resolveId: {
        filter: {
          id: /^(void\/md(\/pages)?|@void-x\/md\/runtime|\/@void-md-(svelte|solid)\/)/,
        },
        handler(source: string) {
          if (source === "void/md" || source === "@void-x/md/runtime") {
            return "\0void-md-runtime";
          }
          if (source === "void/md/pages") {
            return "\0void-md-pages";
          }
          if (source.startsWith(SVELTE_VIRTUAL_PREFIX) || source.startsWith(SOLID_VIRTUAL_PREFIX)) {
            return source;
          }
        },
      },

      load: {
        // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
        filter: { id: /^(\0void-md|\/@void-md-(svelte|solid)\/)/ },
        handler(id: string) {
          if (id.startsWith(SVELTE_VIRTUAL_PREFIX)) {
            const source = svelteModules.get(id);
            if (source) return source;
            throw new Error(`[void-md] Missing Svelte markdown module: ${id}`);
          }
          if (id.startsWith(SOLID_VIRTUAL_PREFIX)) {
            const source = solidModules.get(id);
            if (source) return source;
            throw new Error(`[void-md] Missing Solid markdown module: ${id}`);
          }

          if (id === "\0void-md-runtime") {
            if (adapter === "vue") {
              return `
import { inject } from "vue";
export function useFrontmatter() { return inject("__void_frontmatter", {}); }
`;
            }
            if (adapter === "react") {
              return `
import { createContext, useContext } from "react";
export const FrontmatterContext = createContext({});
export function useFrontmatter() { return useContext(FrontmatterContext) ?? {}; }
`;
            }
            if (adapter === "svelte") {
              return `
import { getContext, setContext } from "svelte";
const FRONTMATTER_KEY = "__void_frontmatter";
export function setFrontmatter(frontmatter) { setContext(FRONTMATTER_KEY, frontmatter); }
export function useFrontmatter() { return getContext(FRONTMATTER_KEY) ?? {}; }
`;
            }
            if (adapter === "solid") {
              return `
import { createContext, useContext } from "solid-js";
export const FrontmatterContext = createContext({});
export function useFrontmatter() { return useContext(FrontmatterContext) ?? {}; }
`;
            }
            throw new Error("[void-md] Adapter not initialized");
          }
          if (id === "\0void-md-pages") {
            return `export default ${JSON.stringify(mdPages)};`;
          }
        },
      },

      transform: {
        filter: { id: /\.md$/ },
        async handler(code: string, _id: string) {
          const { body, islandImports } = extractScript(code);
          const result = await compile(body, { shiki: options?.shiki });

          if (adapter === "vue") {
            if (islandImports.length > 0) {
              return {
                code: emitVueComponentWithIslands(result, islandImports),
                map: null,
              };
            }
            return { code: emitVueComponent(result), map: null };
          }

          if (adapter === "react") {
            if (islandImports.length > 0) {
              return {
                code: emitReactComponentWithIslands(result, islandImports),
                map: null,
              };
            }
            return { code: emitReactComponent(result), map: null };
          }

          if (adapter === "svelte") {
            const virtualId = createVirtualModuleId(SVELTE_VIRTUAL_PREFIX, _id, code, "svelte");
            svelteModules.set(
              virtualId,
              islandImports.length > 0
                ? emitSvelteComponentWithIslands(result, islandImports)
                : emitSvelteComponent(result),
            );
            return {
              code: `export { default, frontmatter, headings } from ${JSON.stringify(virtualId)};`,
              map: null,
            };
          }

          if (adapter === "solid") {
            const virtualId = createVirtualModuleId(SOLID_VIRTUAL_PREFIX, _id, code, "tsx");
            solidModules.set(
              virtualId,
              islandImports.length > 0
                ? emitSolidComponentWithIslands(result, islandImports)
                : emitSolidComponent(result),
            );
            return {
              code: `export { default, frontmatter, headings } from ${JSON.stringify(virtualId)};`,
              map: null,
            };
          }

          throw new Error(`[void-md] Unsupported adapter: ${adapter}`);
        },
      },
    },
  ];
}

export type { CompileOptions, CompileResult } from "./compile";
export type { IslandImport, ScriptExtraction } from "./extract-script";
export type { MdPage };
