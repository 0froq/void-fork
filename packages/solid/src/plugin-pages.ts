import type { Plugin } from "vite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { scanPages } from "void/pages";
import type { PageScanResult } from "void/pages";
import { generateComponentManifest } from "./pages-manifest";

const RENDERER_ID = "virtual:void-pages-renderer";
const CLIENT_ENTRY_ID = "virtual:void-pages-client";

interface PagesPluginOptions {
  viewTransitions?: boolean;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);

  return {
    name: "void-solid:pages",

    async buildStart() {
      if (existsSync(pagesDir)) {
        pageScan = await scanPages(root);
      }
    },

    resolveId: {
      filter: { id: /^virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        return "\0" + id;
      },
    },

    load: {
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        if (id === "\0" + RENDERER_ID) {
          if (!pageScan)
            return "export function renderPage() { throw new Error('No pages found'); }";
          return generateRendererModule(pageScan, pagesDir);
        }
        if (id === "\0" + CLIENT_ENTRY_ID) {
          if (!pageScan) return "";
          return generateClientEntry(pageScan, pagesDir, options?.viewTransitions);
        }
      },
    },

    config(_, env) {
      if (!existsSync(pagesDir)) return;

      if (env.command === "serve") {
        return {
          optimizeDeps: {
            // Exclude @voidcloud/solid so the virtual module and user
            // components share the same Solid context objects (identity).
            exclude: ["@voidcloud/solid"],
            // Pre-include Solid entries discovered late via dynamic imports
            include: ["solid-js", "solid-js/web", "solid-js/store"],
          },
        };
      }

      return {
        build: {
          manifest: true,
          rollupOptions: {
            input: CLIENT_ENTRY_ID,
          },
        },
      };
    },
  };
}

function generateRendererModule(scan: PageScanResult, pagesDir: string): string {
  return `
import { renderToStringAsync, generateHydrationScript } from "solid-js/web";
import { createComponent } from "solid-js";
import { SharedContext, ErrorsContext, RouterContext } from "@voidcloud/solid";

${generateComponentManifest(scan, pagesDir)}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderPage(pageObj, assetTags) {
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
            return createComponent(RouterContext.Provider, {
              value: null,
              get children() {
                // Build layout chain inside providers so contexts are available
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
    });
  }

  // Use createComponent to match the client's hydration tree structure
  const html = await renderToStringAsync(() => createComponent(ServerApp, {}));

  const pageData = escapeAttr(JSON.stringify(pageObj));

  return \`<!doctype html>
<html>
<head>\${assetTags.head}\${generateHydrationScript()}</head>
<body>
  <div id="app" data-page="\${pageData}">\${html}</div>
  \${assetTags.body}
</body>
</html>\`;
}
`;
}

function generateClientEntry(
  scan: PageScanResult,
  pagesDir: string,
  viewTransitions?: boolean,
): string {
  return `
import { createSignal, createComponent, batch } from "solid-js";
import { hydrate } from "solid-js/web";
import { SharedContext, ErrorsContext, RouterContext } from "@voidcloud/solid";

const VIEW_TRANSITIONS_ENABLED = ${!!viewTransitions};

${generateComponentManifest(scan, pagesDir)}

// --- Reactive state ---
const [component, setComponent] = createSignal(null);
const [pageProps, setPageProps] = createSignal({});
const [layouts, setLayouts] = createSignal([]);
const [shared, setShared] = createSignal({});
const [errors, setErrors] = createSignal({});

// --- Component resolution ---
async function resolveComponent(id) {
  const loader = components[id];
  if (!loader) throw new Error("Unknown page component: " + id);
  return (await loader()).default;
}

async function resolveLayouts(componentId) {
  const ids = layoutTree[componentId] || [];
  return Promise.all(ids.map(async (id) => (await components[id]()).default));
}

// --- Router ---
const router = {
  async visit(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = { "X-VoidPages": "true", "Accept": "application/json" };
    const fetchOptions = { method, headers };

    if (options.data && method !== "GET") {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.data);
    }

    const response = await fetch(url, fetchOptions);

    if (response.redirected) {
      return router.visit(response.url);
    }

    const pageData = await response.json();

    // Resolve async work before starting the transition
    const [comp, layoutComps] = await Promise.all([
      resolveComponent(pageData.component),
      resolveLayouts(pageData.component),
    ]);

    const applyUpdate = () => {
      batch(() => {
        setPageProps(pageData.props);
        setComponent(() => comp);
        setLayouts(layoutComps);
        setShared((prev) => ({ ...prev, ...(pageData.shared || {}) }));
        setErrors(pageData.errors || {});
      });
    };

    const useTransition = options.viewTransition ?? VIEW_TRANSITIONS_ENABLED;
    if (useTransition && document.startViewTransition) {
      document.startViewTransition(applyUpdate);
    } else {
      applyUpdate();
    }

    if (!options.preserveState) {
      window.history.pushState({}, "", pageData.url);
    }

    return pageData;
  },

  async reload() {
    return router.visit(window.location.pathname + window.location.search, {
      preserveState: true,
    });
  },

  post(url, data, options = {}) {
    return router.visit(url, { ...options, method: "POST", data });
  },
  put(url, data, options = {}) {
    return router.visit(url, { ...options, method: "PUT", data });
  },
  patch(url, data, options = {}) {
    return router.visit(url, { ...options, method: "PATCH", data });
  },
  delete(url, options = {}) {
    return router.visit(url, { ...options, method: "DELETE" });
  },
};

// --- Root App component ---
function App() {
  return createComponent(SharedContext.Provider, {
    get value() { return shared(); },
    get children() {
      return createComponent(ErrorsContext.Provider, {
        value: errors,
        get children() {
          return createComponent(RouterContext.Provider, {
            value: router,
            get children() {
              // All signal reads must be inside this reactive getter so Solid
              // re-evaluates when navigation updates component/props/layouts.
              const Comp = component();
              if (!Comp) return null;
              let element = createComponent(Comp, pageProps());
              const layoutList = layouts();
              for (let i = layoutList.length - 1; i >= 0; i--) {
                const Layout = layoutList[i];
                const child = element;
                element = createComponent(Layout, { get children() { return child; } });
              }
              return element;
            }
          });
        }
      });
    }
  });
}

// --- Initialize ---
const appEl = document.getElementById("app");
const initialPageData = JSON.parse(appEl.getAttribute("data-page"));

const [initialComp, initialLayouts] = await Promise.all([
  resolveComponent(initialPageData.component),
  resolveLayouts(initialPageData.component),
]);

batch(() => {
  setComponent(() => initialComp);
  setPageProps(initialPageData.props);
  setLayouts(initialLayouts);
  setShared(initialPageData.shared || {});
  setErrors(initialPageData.errors || {});
});

hydrate(() => createComponent(App, {}), appEl);
appEl.setAttribute("data-hydrated", "true");

window.addEventListener("popstate", () => {
  router.visit(window.location.pathname + window.location.search, { preserveState: true });
});
`;
}
