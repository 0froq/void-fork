import type { Plugin } from "vite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { scanPages } from "void/pages";
import type { LayoutDefinition, PageScanResult } from "void/pages";
import { generateComponentManifest } from "./pages-manifest";

const ISLANDS_RENDERER_ID = "virtual:void-islands-renderer";
const ISLANDS_CLIENT_ENTRY_ID = "virtual:void-islands-client";

const COMPONENT_EXTENSIONS = [".svelte", ".ts", ".js"];

/**
 * Prefix for virtual island wrapper modules. Must NOT use the `\0` prefix
 * because `@sveltejs/vite-plugin-svelte` skips `\0`-prefixed modules in
 * its transform filter.
 */
const WRAPPER_PREFIX = "/@void-island-wrap/";

interface IslandEntry {
  componentPath: string;
  islandId: string;
  hydrate: string;
}

/** Resolve a relative import specifier to an absolute path by checking extensions. */
function resolveSpecifier(specifier: string, importerDir: string): string | null {
  const base = resolve(importerDir, specifier);
  for (const ext of COMPONENT_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  if (existsSync(base)) return base;
  return null;
}

/** Quick sync check for .island.svelte files in the pages directory. */
function hasIslandFiles(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(".island.svelte")) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function resolveLayoutChain(componentId: string, layouts: LayoutDefinition[]): LayoutDefinition[] {
  const parts = componentId.split("/");
  const chain: LayoutDefinition[] = [];
  const root = layouts.find((l) => l.directory === "");
  if (root) chain.push(root);
  let dir = "";
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    const layout = layouts.find((l) => l.directory === dir);
    if (layout) chain.push(layout);
  }
  return chain;
}

function fileHasCssImports(filePath: string): boolean {
  try {
    const code = readFileSync(filePath, "utf-8");
    return /import\b[^"']*["'][^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)["']/.test(
      code,
    );
  } catch {
    return false;
  }
}

function extractCssImports(filePath: string): string {
  const code = readFileSync(filePath, "utf-8");
  const re =
    /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
  const imports: string[] = [];
  let match;
  while ((match = re.exec(code)) !== null) {
    imports.push(`@import ${JSON.stringify(match[1])};`);
  }
  return imports.join("\n");
}

export function islandsPlugin(pagesDir: string): Plugin[] {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  let isDev = false;
  let viteRoot = "";
  const islandCssMap = new Map<string, string[]>();

  /** Rebuild islandCssMap from current file contents (re-runs fileHasCssImports). */
  function rebuildIslandCssMap(): void {
    if (!pageScan) return;
    islandCssMap.clear();
    for (const page of pageScan.pages) {
      if (!page.island) continue;
      const cssPaths: string[] = [];
      const layoutChain = resolveLayoutChain(page.componentId, pageScan.layouts);
      for (const layout of layoutChain) {
        const layoutPath = resolve(pagesDir, layout.filePath);
        if (fileHasCssImports(layoutPath)) cssPaths.push(layoutPath);
      }
      const pagePath = resolve(pagesDir, page.componentPath);
      if (fileHasCssImports(pagePath)) cssPaths.push(pagePath);
      if (cssPaths.length > 0) {
        islandCssMap.set(page.componentId, cssPaths);
      }
    }
  }

  return [
    {
      name: "void-svelte:islands",
      enforce: "pre",

      configResolved(config) {
        viteRoot = config.root;
        isDev = config.command === "serve";
      },

      // Serve virtual island CSS as raw text/css in dev. The client transform
      // produces a JS module with `__vite__css = "..."` for HMR — we extract
      // the CSS string and serve it directly for render-blocking <link> tags.
      configureServer(server) {
        // When an island CSS file changes, rebuild the CSS map and invalidate
        // the renderer so the next SSR render picks up added/removed styles.
        server.watcher.on("change", (path) => {
          if (!islandCssFiles.has(path)) return;
          rebuildIslandCssMap();
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById("\0" + ISLANDS_RENDERER_ID);
            if (mod) env.moduleGraph.invalidateModule(mod);
          }
          const cssMod = server.environments.client?.moduleGraph.getModuleById(path + ".css");
          if (cssMod) server.environments.client.moduleGraph.invalidateModule(cssMod);
        });

        server.middlewares.use(async (req, res, next) => {
          if (!req.url) return next();
          const url = req.url.split("?")[0];
          if (!url.endsWith(".css")) return next();
          const srcPath = resolve(viteRoot, url.slice(1, -4));
          if (!islandCssFiles.has(srcPath)) return next();
          try {
            const result = await server.environments.client.transformRequest(url);
            if (result) {
              const m =
                result.code.match(/\b__vite__css\s*=\s*("(?:[^"\\]|\\.)*")/) ||
                result.code.match(/export\s+default\s+("(?:[^"\\]|\\.)*")/);
              if (m) {
                res.setHeader("Content-Type", "text/css");
                res.statusCode = 200;
                res.end(JSON.parse(m[1]));
                return;
              }
            }
          } catch {
            // fall through
          }
          next();
        });
      },

      async buildStart() {
        if (existsSync(pagesDir)) {
          pageScan = await scanPages(root);
          // Pre-scan island pages to populate the manifest eagerly.
          // This is needed because the client build may load the virtual
          // islands-client entry before island page transforms run.
          const importAttrRe =
            /import\s+\w+\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;
          for (const page of pageScan.pages) {
            if (!page.island) continue;
            const filePath = resolve(pagesDir, page.componentPath);
            const code = readFileSync(filePath, "utf-8");
            const importerDir = dirname(filePath);
            importAttrRe.lastIndex = 0;
            let m;
            while ((m = importAttrRe.exec(code)) !== null) {
              const spec = m[1].slice(1, -1);
              const strategy = m[2].slice(1, -1);
              const absPath = resolveSpecifier(spec, importerDir);
              if (absPath) {
                const islandId = relative(root, absPath).replace(/\.[^.]+$/, "");
                islandManifest.set(islandId, {
                  componentPath: absPath,
                  islandId,
                  hydrate: strategy,
                });
              }
            }
          }

          // Collect page and layout files needing CSS for island pages
          for (const page of pageScan.pages) {
            if (!page.island) continue;
            if (page.componentPath.endsWith(".svelte")) {
              islandCssFiles.add(resolve(pagesDir, page.componentPath));
            }
            const layoutChain = resolveLayoutChain(page.componentId, pageScan.layouts);
            for (const layout of layoutChain) {
              islandCssFiles.add(resolve(pagesDir, layout.filePath));
            }
          }

          // Build CSS map for dev FOUC prevention (only files with CSS imports)
          rebuildIslandCssMap();
        }
      },

      resolveId: {
        filter: {
          id: /^(virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)|\.svelte\.css$/,
        },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return "\0" + source;
          }
          // Virtual wrapper modules — resolve without \0 prefix so the
          // Svelte vite plugin processes them as .svelte files
          if (source.startsWith(WRAPPER_PREFIX)) {
            return source;
          }
          // Virtual island CSS modules — no \0 prefix so Vite CSS pipeline processes them.
          // Return absolute path so CSS @import resolution uses the correct directory.
          if (source.endsWith(".css")) {
            const srcPath = source.slice(0, -4);
            if (islandCssFiles.has(srcPath)) return srcPath + ".css";
            if (srcPath.startsWith("/")) {
              const absPath = resolve(viteRoot, srcPath.slice(1));
              if (islandCssFiles.has(absPath)) return absPath + ".css";
            }
          }
        },
      },

      load: {
        // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
        filter: {
          id: /^(\0virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)|\.svelte\.css$/,
        },
        handler(id) {
          if (id === "\0" + ISLANDS_RENDERER_ID) {
            if (!pageScan) {
              return "export function renderIslandPage() { throw new Error('No pages found'); }";
            }
            return generateIslandRenderer(pageScan, pagesDir, isDev, islandCssMap, viteRoot);
          }
          if (id === "\0" + ISLANDS_CLIENT_ENTRY_ID) {
            if (!pageScan) return "";
            return generateIslandClientEntry(islandManifest, islandCssFiles, isDev);
          }
          // Virtual wrapper component — generates a .svelte wrapper
          if (id.startsWith(WRAPPER_PREFIX)) {
            return generateWrapperComponent(id);
          }
          // Virtual island CSS module — resolveId returns absolute path
          if (id.endsWith(".css") && !id.startsWith("\0")) {
            const srcPath = id.slice(0, -4);
            if (islandCssFiles.has(srcPath)) {
              return extractCssImports(srcPath);
            }
          }
        },
      },

      // Rewrite island imports to point to virtual wrapper components.
      // The wrapper module is a generated .svelte file that the Svelte
      // vite plugin compiles normally, wrapping the original component
      // with data-island/data-props/data-hydrate attributes.
      transform: {
        filter: { id: /\.island\.svelte$/ },
        handler(code, id) {
          if (/import\s+\{[^}]*\buseForm\b/.test(code)) {
            this.warn(
              `useForm imported in island page "${id}" — useForm requires the Inertia client-side router. Use useIslandForm instead.`,
            );
          }

          const importAttrRe =
            /import\s+(\w+)\s+from\s+("[^"]+"|'[^']+')\s+with\s*\{\s*island\s*:\s*("[^"]+"|'[^']+')\s*\}/g;

          const importerDir = dirname(id);
          let transformed = code;
          let match;

          while ((match = importAttrRe.exec(code)) !== null) {
            const name = match[1];
            const specRaw = match[2];
            const strategyRaw = match[3];
            const spec = specRaw.slice(1, -1);
            const strategy = strategyRaw.slice(1, -1);

            // Resolve to absolute path for the island manifest
            const absPath = resolveSpecifier(spec, importerDir);
            if (absPath) {
              const islandId = relative(root, absPath).replace(/\.[^.]+$/, "");
              islandManifest.set(islandId, {
                componentPath: absPath,
                islandId,
                hydrate: strategy,
              });
            }

            const islandId = absPath ? relative(root, absPath).replace(/\.[^.]+$/, "") : spec;

            // Rewrite import to point to virtual wrapper component
            const wrapperUrl =
              WRAPPER_PREFIX +
              encodeURIComponent(islandId) +
              ".svelte?src=" +
              encodeURIComponent(absPath || spec) +
              "&island=" +
              encodeURIComponent(islandId) +
              "&hydrate=" +
              encodeURIComponent(strategy);
            const replacement = `import ${name} from ${JSON.stringify(wrapperUrl)}`;
            transformed = transformed.replace(match[0], replacement);
          }

          if (transformed !== code) {
            return { code: transformed, map: null };
          }
        },
      },

      config(_, env) {
        if (!existsSync(pagesDir)) return;
        if (env.command === "serve") {
          return { optimizeDeps: { include: ["svelte"] } };
        }
        // Only add the islands client entry when island pages actually exist
        if (hasIslandFiles(pagesDir)) {
          return {
            environments: {
              client: {
                build: {
                  rollupOptions: {
                    input: { "islands-client": ISLANDS_CLIENT_ENTRY_ID },
                  },
                },
              },
            },
          };
        }
      },
    },
    {
      name: "void-svelte:islands-style",

      resolveId: {
        filter: { id: /\?island-style&/ },
        handler(source) {
          return source;
        },
      },

      load: {
        filter: { id: /\?island-style&/ },
        handler(id) {
          // ?island-style&index=N&lang.{ext} — return raw CSS of Nth <style> block
          const filePath = id.replace(/\?island-style&.*$/, "");
          const params = new URLSearchParams(id.slice(id.indexOf("?island-style&") + 1));
          const index = parseInt(params.get("index") || "0", 10);
          const content = readFileSync(filePath, "utf-8");
          const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
          let match;
          let i = 0;
          while ((match = styleBlockRe.exec(content)) !== null) {
            if (i === index) return match[1];
            i++;
          }
          return "/* style block not found */";
        },
      },
    },
  ];
}

/**
 * Generate a virtual Svelte wrapper component from a wrapper URL.
 * The URL encodes: src (absolute component path), island (ID), hydrate (strategy).
 */
function generateWrapperComponent(id: string): string {
  const url = new URL(id, "file://");
  const src = decodeURIComponent(url.searchParams.get("src") || "");
  const islandId = decodeURIComponent(url.searchParams.get("island") || "");
  const hydrate = decodeURIComponent(url.searchParams.get("hydrate") || "load");

  return `<script>
  import Cmp from ${JSON.stringify(src)};
  let props = $props();
</script>
<div data-island="${islandId}" data-props={JSON.stringify(props)} data-hydrate="${hydrate}">
  <Cmp {...props} />
</div>
`;
}

function generateIslandRenderer(
  scan: PageScanResult,
  pagesDir: string,
  isDev: boolean,
  islandCssMap: Map<string, string[]>,
  viteRoot: string,
): string {
  // Build CSS link map for dev FOUC prevention
  let cssMapCode = "";
  if (isDev && islandCssMap.size > 0) {
    const cssMapObj: Record<string, string[]> = {};
    for (const [compId, paths] of islandCssMap) {
      cssMapObj[compId] = paths.map((p) => "/" + relative(viteRoot, p) + ".css");
    }
    cssMapCode = `const __cssPaths = ${JSON.stringify(cssMapObj)};`;
  }

  return `
import { render } from "svelte/server";
import App from "@void-x/svelte/App.svelte";

${generateComponentManifest(scan, pagesDir)}
${cssMapCode}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const { html, head } = render(App, {
    props: {
      page: PageComponent,
      layouts: layoutComponents,
      pageProps: pageObj.props,
      shared: pageObj.shared || {},
      errors: pageObj.errors || {},
      router: null,
      stores: null,
    },
  });

  return \`<!doctype html>
<html>
<head>\${typeof __cssPaths !== "undefined" ? (__cssPaths[pageObj.component] || []).map(url => '<link rel="stylesheet" href="' + url + '">').join("\\n") : ""}\${head}\${assetTags.head}</head>
<body>
  <div id="app">\${html}</div>
  \${assetTags.body}
</body>
</html>\`;
}
`;
}

function generateIslandClientEntry(
  manifest: Map<string, IslandEntry>,
  cssFiles: Set<string>,
  isDev: boolean,
): string {
  const entries = [...manifest.values()];
  const uniqueIslands = new Map<string, string>();
  for (const entry of entries) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: string[] = [];

  // In dev, page/layout CSS is served via render-blocking <link> tags
  // injected in the SSR HTML. Skip CSS imports here to avoid duplicate injection.
  // In production, the <link> tags aren't used — the imports below ensure
  // the CSS is included in the bundled output.
  if (!isDev) {
    for (const file of cssFiles) {
      const content = readFileSync(file, "utf-8");

      // Extract <style> blocks → emit ?island-style imports
      const styleRe = /<style\b([^>]*)>/g;
      styleRe.lastIndex = 0;
      let styleIndex = 0;
      let styleMatch;
      while ((styleMatch = styleRe.exec(content)) !== null) {
        const attrs = styleMatch[1];
        const langMatch = attrs.match(/\blang\s*=\s*["'](\w+)["']/);
        const lang = langMatch ? langMatch[1] : "css";
        lines.push(
          `import ${JSON.stringify(file + "?island-style&index=" + styleIndex + "&lang." + lang)};`,
        );
        styleIndex++;
      }

      // Extract CSS imports from <script> blocks
      const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
      const cssImportRe =
        /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
      let scriptMatch;
      while ((scriptMatch = scriptRe.exec(content)) !== null) {
        const scriptContent = scriptMatch[1];
        let cssMatch;
        cssImportRe.lastIndex = 0;
        while ((cssMatch = cssImportRe.exec(scriptContent)) !== null) {
          lines.push(cssMatch[0].trim() + ";");
        }
      }
    }
  }

  lines.push("const islands = {");
  for (const [id, path] of uniqueIslands) {
    lines.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(path)}),`);
  }
  lines.push("};");

  lines.push(`
async function hydrateIsland(el, mod, props) {
  const { hydrate } = await import("svelte");
  const Component = mod.default || mod;
  hydrate(Component, { target: el, props });
  el.setAttribute("data-hydrated", "true");
}

function scheduleHydration(el, loader, props, strategy) {
  const run = () => loader().then(mod => hydrateIsland(el, mod, props));

  if (strategy === "load") {
    run();
  } else if (strategy === "visible") {
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        run();
      }
    });
    observer.observe(el);
  } else if (strategy === "idle") {
    const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
    schedule(() => run());
  } else if (strategy.startsWith("media:")) {
    const query = strategy.slice(6);
    const mql = matchMedia(query);
    const check = () => {
      if (mql.matches) {
        mql.removeEventListener("change", check);
        run();
      }
    };
    mql.addEventListener("change", check);
    check();
  }
}

document.querySelectorAll("[data-island]").forEach(el => {
  const id = el.getAttribute("data-island");
  const props = JSON.parse(el.getAttribute("data-props") || "{}");
  const strategy = el.getAttribute("data-hydrate") || "load";
  const loader = islands[id];
  if (loader) scheduleHydration(el, loader, props, strategy);
});
`);

  return lines.join("\n");
}
