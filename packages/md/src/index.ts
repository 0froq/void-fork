import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { compile } from "./compile";
import type { CompileOptions } from "./compile";
import { extractScript } from "./extract-script";
import { emitVueComponent, emitVueComponentWithIslands } from "./emit-vue";

type FrameworkAdapter = "vue" | "react" | "svelte" | "solid";

const ADAPTER_PLUGIN_NAMES: Record<string, FrameworkAdapter> = {
  "void-vue:pages": "vue",
  "void-react:pages": "react",
  "void-svelte:pages": "svelte",
  "void-solid:pages": "solid",
};

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
        filter: { id: /^(void\/md(\/pages)?|@void-x\/md\/runtime)$/ },
        handler(source: string) {
          if (source === "void/md" || source === "@void-x/md/runtime") {
            return "\0void-md-runtime";
          }
          if (source === "void/md/pages") {
            return "\0void-md-pages";
          }
        },
      },

      load: {
        // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
        filter: { id: /^\0void-md/ },
        handler(id: string) {
          if (id === "\0void-md-runtime") {
            if (adapter === "vue") {
              return `
import { inject } from "vue";
export function useFrontmatter() { return inject("__void_frontmatter", {}); }
`;
            }
            throw new Error(`[void-md] Unsupported adapter: ${adapter}`);
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
          throw new Error(`[void-md] Unsupported adapter: ${adapter}`);
        },
      },
    },
  ];
}

export type { CompileOptions, CompileResult } from "./compile";
export type { IslandImport, ScriptExtraction } from "./extract-script";
export type { MdPage };
