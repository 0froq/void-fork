import type { Plugin } from "vite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { scanPages } from "void/pages";
import type { LayoutDefinition, PageScanResult } from "void/pages";
import { generateComponentManifest } from "./pages-manifest";

const ISLANDS_RENDERER_ID = "virtual:void-islands-renderer";
const ISLANDS_CLIENT_ENTRY_ID = "virtual:void-islands-client";

const COMPONENT_EXTENSIONS = [".vue", ".tsx", ".jsx", ".ts", ".js"];

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

/** Quick sync check for .island.vue files in the pages directory. */
function hasIslandFiles(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(".island.vue")) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function hasMdFilesWithScript(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const fullPath = join(entry.parentPath, entry.name);
        const content = readFileSync(fullPath, "utf-8");
        if (/^<script\b/m.test(content)) return true;
      }
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

function fileHasCss(filePath: string): boolean {
  try {
    const code = readFileSync(filePath, "utf-8");
    // JS-style CSS imports
    if (/import\b[^"']*["'][^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)["']/.test(code))
      return true;
    // Vue <style> blocks (non-scoped — scoped needs Vue plugin processing)
    if (/<style\b(?![^>]*\bscoped\b)[^>]*>/.test(code)) return true;
    return false;
  } catch {
    return false;
  }
}

function extractCss(filePath: string): string {
  const code = readFileSync(filePath, "utf-8");
  const parts: string[] = [];

  // JS-style CSS imports → @import
  const jsRe =
    /^\s*import\b[^"']*["']([^"']+\.(?:css|scss|sass|less|styl|stylus|pcss|postcss))["']/gm;
  let match;
  while ((match = jsRe.exec(code)) !== null) {
    parts.push(`@import ${JSON.stringify(match[1])};`);
  }

  // Vue <style> block contents (non-scoped only)
  const styleBlockRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/g;
  while ((match = styleBlockRe.exec(code)) !== null) {
    const attrs = match[1];
    if (/\bscoped\b/.test(attrs)) continue;
    const content = match[2].trim();
    if (content) parts.push(content);
  }

  return parts.join("\n");
}

export function islandsPlugin(pagesDir: string): Plugin[] {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  let isDev = false;
  let viteRoot = "";
  const islandCssMap = new Map<string, string[]>();
  let resolvedConfig: any;
  let mdClientScriptIds = new Set<string>();

  /** Rebuild islandCssMap from current file contents (re-runs fileHasCss). */
  function rebuildIslandCssMap(): void {
    if (!pageScan) return;
    islandCssMap.clear();
    for (const page of pageScan.pages) {
      if (!page.island) continue;
      const cssPaths: string[] = [];
      const layoutChain = resolveLayoutChain(page.componentId, pageScan.layouts);
      for (const layout of layoutChain) {
        const layoutPath = resolve(pagesDir, layout.filePath);
        if (fileHasCss(layoutPath)) cssPaths.push(layoutPath);
      }
      const pagePath = resolve(pagesDir, page.componentPath);
      if (fileHasCss(pagePath)) cssPaths.push(pagePath);
      if (cssPaths.length > 0) {
        islandCssMap.set(page.componentId, cssPaths);
      }
    }
  }

  /** Lazily read md client scripts from the md plugin API.
   *  Must be called from load() hooks (not buildStart) because the md plugin's
   *  buildStart may not have run yet when the islands plugin's buildStart runs. */
  function refreshMdClientScriptIds(): Set<string> {
    const mdPlugin = resolvedConfig?.plugins?.find((p: any) => p.name === "void-md");
    const mdScripts: Map<string, string> | undefined = mdPlugin?.api?.getClientScripts?.();
    mdClientScriptIds = new Set(mdScripts?.keys() ?? []);
    return mdClientScriptIds;
  }

  return [
    {
      name: "void-vue:islands",
      enforce: "pre",

      configResolved(config) {
        resolvedConfig = config;
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
          // Invalidate the renderer virtual module so it regenerates __cssPaths
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById("\0" + ISLANDS_RENDERER_ID);
            if (mod) env.moduleGraph.invalidateModule(mod);
          }
          // Invalidate the CSS virtual module so fresh content is served
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
              // Vite 8 client CSS: `const __vite__css = "..."`
              // Vite 7 SSR CSS: `export default "..."`
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

          // Collect .vue files needing CSS for island pages
          for (const page of pageScan.pages) {
            if (!page.island) continue;
            if (page.componentPath.endsWith(".vue")) {
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
        filter: { id: /^virtual:void-islands-(renderer|client)$|\.vue\.css$/ },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return "\0" + source;
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
        filter: { id: /^\0virtual:void-islands-(renderer|client)$|\.vue\.css$/ },
        handler(id) {
          if (id === "\0" + ISLANDS_RENDERER_ID) {
            if (!pageScan) {
              return "export function renderIslandPage() { throw new Error('No pages found'); }";
            }
            refreshMdClientScriptIds();
            return generateIslandRenderer(
              pageScan,
              pagesDir,
              isDev,
              islandCssMap,
              viteRoot,
              mdClientScriptIds,
            );
          }
          if (id === "\0" + ISLANDS_CLIENT_ENTRY_ID) {
            if (!pageScan) return "";
            refreshMdClientScriptIds();
            return generateIslandClientEntry(
              islandManifest,
              islandCssFiles,
              isDev,
              mdClientScriptIds,
            );
          }
          // Virtual island CSS module — resolveId returns absolute path
          if (id.endsWith(".css") && !id.startsWith("\0")) {
            const srcPath = id.slice(0, -4);
            if (islandCssFiles.has(srcPath)) {
              return extractCss(srcPath);
            }
          }
        },
      },

      // Rewrite island imports inline — the workerd module runner resolves imports
      // from the pre-transform AST, so we can't rely on resolveId to intercept
      // rewritten specifiers. Instead, we replace each island import with:
      //   1. A renamed import of the raw component
      //   2. An inline wrapper that adds data-island/data-props/data-hydrate attributes
      // This also populates the islandManifest for the client entry.
      transform: {
        filter: { id: /\.island\.vue$/ },
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
          const wrappers: string[] = [];
          let idx = 0;
          let match;

          while ((match = importAttrRe.exec(code)) !== null) {
            const name = match[1];
            const specRaw = match[2];
            const strategyRaw = match[3];
            const spec = specRaw.slice(1, -1);
            const strategy = strategyRaw.slice(1, -1);
            const rawName = `_raw_island_${idx++}`;

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

            // Replace the import with a renamed import
            const replacement = `import ${rawName} from ${specRaw}`;
            transformed = transformed.replace(match[0], replacement);

            // Generate wrapper that adds data-island attributes during SSR.
            // Uses Vue's h() function for createElement.
            wrappers.push(
              `const ${name} = {` +
                ` inheritAttrs: false,` +
                ` render() {` +
                ` const props = this.$attrs;` +
                ` return _h_island("div", {` +
                ` "data-island": ${JSON.stringify(islandId)},` +
                ` "data-props": JSON.stringify(props),` +
                ` "data-hydrate": ${JSON.stringify(strategy)}` +
                ` }, _h_island(${rawName}, props));` +
                ` }` +
                ` };`,
            );
          }

          if (wrappers.length > 0) {
            // Inject into <script setup> block — this transform runs with enforce: "pre"
            // so the Vue SFC compiler hasn't processed the file yet. We must place
            // the h() import and wrapper consts inside the script block.
            const scriptSetupRe = /<script\b[^>]*\bsetup\b[^>]*>/;
            const setupMatch = transformed.match(scriptSetupRe);
            if (setupMatch) {
              const openEnd = setupMatch.index! + setupMatch[0].length;
              const closeIdx = transformed.indexOf("</script>", openEnd);
              if (closeIdx !== -1) {
                transformed =
                  transformed.slice(0, openEnd) +
                  '\nimport { h as _h_island } from "vue";' +
                  transformed.slice(openEnd, closeIdx) +
                  "\n" +
                  wrappers.join("\n") +
                  "\n" +
                  transformed.slice(closeIdx);
              }
            }
            return { code: transformed, map: null };
          }
        },
      },

      config(_, env) {
        if (!existsSync(pagesDir)) return;
        if (env.command === "serve") {
          return { optimizeDeps: { include: ["vue"] } };
        }
        // Only add the islands client entry when island pages or md scripts exist
        if (hasIslandFiles(pagesDir) || hasMdFilesWithScript(pagesDir)) {
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
  ];
}

function generateIslandRenderer(
  scan: PageScanResult,
  pagesDir: string,
  isDev: boolean,
  islandCssMap: Map<string, string[]>,
  viteRoot: string,
  mdScriptIds: Set<string>,
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

  const mdScriptIdsCode = `const __mdClientScriptIds = new Set(${JSON.stringify([...mdScriptIds])});`;

  return `
import { createSSRApp, h, reactive, provide } from "vue";
import { renderToString } from "vue/server-renderer";

${generateComponentManifest(scan, pagesDir)}
${cssMapCode}
${mdScriptIdsCode}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const __pageModule = await components[pageObj.component]();
  const PageComponent = __pageModule.default;
  const __frontmatter = __pageModule.frontmatter;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const app = createSSRApp({
    setup() {
      provide("__void_shared", reactive(pageObj.shared || {}));
      provide("__void_errors", reactive(pageObj.errors || {}));
      if (__frontmatter) provide("__void_frontmatter", __frontmatter);
      // No router provided — islands have no client-side router
      return () => {
        let vnode = h(PageComponent, pageObj.props);
        for (let i = layoutComponents.length - 1; i >= 0; i--) {
          const inner = vnode;
          vnode = h(layoutComponents[i], null, { default: () => inner });
        }
        return vnode;
      };
    }
  });

  const html = await renderToString(app);
  const __mdScriptAttr = __mdClientScriptIds.has(pageObj.component) ? \` data-md-script="\${escapeAttr(pageObj.component)}"\` : "";

  return \`<!doctype html>
<html>
<head>\${typeof __cssPaths !== "undefined" ? (__cssPaths[pageObj.component] || []).map(url => '<link rel="stylesheet" href="' + url + '">').join("\\n") : ""}\${assetTags.head}</head>
<body>
  <div id="app"\${__mdScriptAttr}>\${html}</div>
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
  mdScriptIds: Set<string>,
): string {
  const entries = [...manifest.values()];
  const uniqueIslands = new Map<string, string>();
  for (const entry of entries) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: string[] = [];

  // In dev, page/layout CSS is served via render-blocking <link> tags
  // injected in the SSR HTML (see generateIslandRenderer). Skip the
  // ?vue&type=style imports here to avoid duplicate injection.
  // In production, the <link> tags aren't used — the style imports below
  // ensure the CSS is included in the bundled output.
  if (!isDev) {
    const styleRe = /<style\b([^>]*)>/g;
    for (const file of cssFiles) {
      const content = readFileSync(file, "utf-8");
      styleRe.lastIndex = 0;
      let index = 0;
      let match;
      while ((match = styleRe.exec(content)) !== null) {
        const attrs = match[1];
        const scoped = /\bscoped\b/.test(attrs);
        const langMatch = attrs.match(/\blang\s*=\s*["'](\w+)["']/);
        const lang = langMatch ? langMatch[1] : "css";
        let query = `?vue&type=style&index=${index}&lang.${lang}`;
        if (scoped) query += "&scoped=true";
        lines.push(`import ${JSON.stringify(file + query)};`);
        index++;
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
  const { createSSRApp, h } = await import("vue");
  const Component = mod.default || mod;
  const app = createSSRApp({ render: () => h(Component, props) });
  app.mount(el);
  el.setAttribute("data-hydrated", "true");
}

function scheduleHydration(el, loader, props, strategy) {
  const hydrate = () => loader().then(mod => hydrateIsland(el, mod, props));

  if (strategy === "load") {
    hydrate();
  } else if (strategy === "visible") {
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        hydrate();
      }
    });
    observer.observe(el);
  } else if (strategy === "idle") {
    const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
    schedule(() => hydrate());
  } else if (strategy.startsWith("media:")) {
    const query = strategy.slice(6);
    const mql = matchMedia(query);
    const check = () => {
      if (mql.matches) {
        mql.removeEventListener("change", check);
        hydrate();
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

  if (mdScriptIds.size > 0) {
    lines.push("");
    lines.push("// Markdown client scripts");
    lines.push("const mdScripts = {");
    for (const id of mdScriptIds) {
      lines.push(
        `  ${JSON.stringify(id)}: () => import(${JSON.stringify("virtual:void-md-script:" + id)}),`,
      );
    }
    lines.push("};");
    lines.push(
      `const mdScriptId = document.getElementById("app")?.getAttribute("data-md-script");`,
    );
    lines.push(`if (mdScriptId && mdScripts[mdScriptId]) mdScripts[mdScriptId]();`);
  }

  return lines.join("\n");
}
