import type { Plugin } from "vite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { scanPages } from "void/pages";
import type { LayoutDefinition, PageScanResult } from "void/pages";
import { generateComponentManifest } from "./pages-manifest";

const ISLANDS_RENDERER_ID = "virtual:void-islands-renderer";
const ISLANDS_CLIENT_ENTRY_ID = "virtual:void-islands-client";

const COMPONENT_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

/**
 * Prefix for virtual island wrapper modules. Must NOT use the `\0` prefix
 * because `vite-plugin-solid` skips `\0`-prefixed modules in its transform
 * filter. Uses a clean `.tsx` extension (no query params) so rolldown can
 * detect the language.
 */
const WRAPPER_PREFIX = "/@void-island-wrap/";

interface IslandEntry {
  componentPath: string;
  islandId: string;
  hydrate: string;
}

interface WrapperMeta {
  src: string;
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

/** Quick sync check for .island.tsx/.island.jsx files in the pages directory. */
function hasIslandFiles(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.island\.(tsx|jsx)$/.test(entry.name)) return true;
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
  let isDev = false;
  const root = dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  // Metadata for virtual wrapper modules — keyed by wrapper URL
  const wrapperMeta = new Map<string, WrapperMeta>();
  let wrapperId = 0;
  let viteRoot = "";
  const islandCssMap = new Map<string, string[]>();

  return [
    {
      name: "void-solid:islands",
      enforce: "pre",

      configResolved(config) {
        viteRoot = config.root;
        isDev = config.command === "serve";
      },

      // Serve virtual island CSS as raw text/css in dev. The SSR transform
      // outputs `export default "css"` instead of a JS module with HMR.
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url) return next();
          const url = req.url.split("?")[0];
          if (!url.endsWith(".css")) return next();
          const srcPath = resolve(viteRoot, url.slice(1, -4));
          if (!islandCssFiles.has(srcPath)) return next();
          try {
            const result = await server.environments.ssr.transformRequest(req.url);
            if (result) {
              const m = result.code.match(/export\s+default\s+("(?:[^"\\]|\\.)*")/);
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
            if (/\.(tsx|jsx)$/.test(page.componentPath)) {
              islandCssFiles.add(resolve(pagesDir, page.componentPath));
            }
            const layoutChain = resolveLayoutChain(page.componentId, pageScan.layouts);
            for (const layout of layoutChain) {
              islandCssFiles.add(resolve(pagesDir, layout.filePath));
            }
          }

          // Build CSS map for dev FOUC prevention (only files with CSS imports)
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
      },

      resolveId: {
        filter: {
          id: /^(virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)|\.(tsx|jsx)\.css$/,
        },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return "\0" + source;
          }
          // Virtual wrapper modules — resolve without \0 prefix so
          // vite-plugin-solid processes them as .tsx files
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
          id: /^(\0virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)|\.(tsx|jsx)\.css$/,
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
            return generateIslandClientEntry(islandManifest, islandCssFiles);
          }
          // Virtual wrapper component — generates a .tsx wrapper
          if (id.startsWith(WRAPPER_PREFIX)) {
            const meta = wrapperMeta.get(id);
            if (meta) return generateWrapperComponent(meta);
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
      // The wrapper module is a generated .tsx file that vite-plugin-solid
      // compiles normally, wrapping the original component with
      // data-island/data-props/data-hydrate attributes.
      transform: {
        filter: { id: /\.island\.(tsx|jsx)$/ },
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

            // Rewrite import to point to virtual wrapper component.
            // Use a clean .tsx path (no query params) so rolldown can detect the
            // language. Store metadata in a Map for the load hook.
            const wrapperUrl = WRAPPER_PREFIX + "island_" + wrapperId++ + ".tsx";
            wrapperMeta.set(wrapperUrl, { src: absPath || spec, islandId, hydrate: strategy });
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
        // Only add the islands client entry when island pages actually exist
        if (env.command !== "serve" && hasIslandFiles(pagesDir)) {
          return {
            build: {
              rollupOptions: {
                input: { "islands-client": ISLANDS_CLIENT_ENTRY_ID },
              },
            },
          };
        }
      },
    },
  ];
}

/**
 * Generate a virtual TSX wrapper component.
 * vite-plugin-solid compiles the JSX for both SSR and client.
 */
function generateWrapperComponent(meta: WrapperMeta): string {
  return `import _Cmp from ${JSON.stringify(meta.src)};
export default function _IslandWrap(props) {
  return <div data-island="${meta.islandId}" data-props={JSON.stringify(props)} data-hydrate="${meta.hydrate}"><_Cmp {...props} /></div>;
}
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
import { renderToStringAsync, generateHydrationScript } from "solid-js/web";
import { createComponent } from "solid-js";
import { SharedContext, ErrorsContext } from "@void-x/solid/runtime";

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

  function ServerApp() {
    return createComponent(SharedContext.Provider, {
      value: pageObj.shared || {},
      get children() {
        return createComponent(ErrorsContext.Provider, {
          value: pageObj.errors || {},
          get children() {
            // Build layout chain inside providers so contexts are available.
            // No RouterContext — islands have no client-side router.
            let element = createComponent(PageComponent, pageObj.props);
            for (let i = layoutComponents.length - 1; i >= 0; i--) {
              const Layout = layoutComponents[i];
              const child = element;
              element = createComponent(Layout, { get children() { return child; } });
            }
            return element;
          }
        });
      }
    });
  }

  const html = await renderToStringAsync(() => createComponent(ServerApp, {}));

  return \`<!doctype html>
<html>
<head>\${typeof __cssPaths !== "undefined" ? (__cssPaths[pageObj.component] || []).map(url => '<link rel="stylesheet" href="' + url + '">').join("\n") : ""}\${assetTags.head}\${generateHydrationScript()}</head>
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
): string {
  const entries = [...manifest.values()];
  const uniqueIslands = new Map<string, string>();
  for (const entry of entries) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: string[] = [];

  // Extract CSS imports directly from island page/layout files.
  // We inline this instead of using a ?island-css virtual module because
  // framework-specific Vite plugins may match the .tsx/.jsx extension in the
  // virtual module ID and try to compile the CSS-only content as a component.
  const cssImportRe =
    /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
  for (const file of cssFiles) {
    const content = readFileSync(file, "utf-8");
    cssImportRe.lastIndex = 0;
    let match;
    while ((match = cssImportRe.exec(content)) !== null) {
      lines.push(match[0].trim() + ";");
    }
  }

  lines.push("const islands = {");
  for (const [id, path] of uniqueIslands) {
    lines.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(path)}),`);
  }
  lines.push("};");

  // Use render (not hydrate) for island activation. Solid's hydrate() uses
  // tree-position-dependent hydration keys that won't match when hydrating a
  // sub-component that was SSR'd deeper in the component tree (inside context
  // providers and layouts). render() replaces the server HTML with a fresh
  // client render — the brief re-render is acceptable for interactive islands.
  lines.push(`
async function mountIsland(el, mod, props) {
  const { render } = await import("solid-js/web");
  const { createComponent } = await import("solid-js");
  const Component = mod.default || mod;
  el.textContent = "";
  render(() => createComponent(Component, props), el);
  el.setAttribute("data-hydrated", "true");
}

function scheduleHydration(el, loader, props, strategy) {
  const run = () => loader().then(mod => mountIsland(el, mod, props));

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
