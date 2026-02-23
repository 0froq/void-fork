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
  let isDev = false;
  const root = dirname(pagesDir);

  return {
    name: "void-react:pages",

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
          return generateRendererModule(pageScan, pagesDir, isDev);
        }
        if (id === "\0" + CLIENT_ENTRY_ID) {
          if (!pageScan) return "";
          return generateClientEntry(pageScan, pagesDir, options?.viewTransitions);
        }
      },
    },

    config(_, env) {
      if (!existsSync(pagesDir)) return;

      // In dev mode, exclude @void-x/react from dep optimization so the
      // virtual module and user components share the same React context objects.
      // Without this, Vite pre-bundles @void-x/react, creating separate
      // context instances that break useContext (React contexts use object identity).
      if (env.command === "serve") {
        isDev = true;
        return {
          optimizeDeps: {
            // Exclude @void-x/react so the virtual module and user
            // components share the same React context objects (identity).
            exclude: ["@void-x/react"],
            // Pre-include React entries that are discovered late via dynamic
            // imports during SPA navigation, avoiding a full-page reload
            // from Vite's dep optimizer.
            include: ["react/jsx-runtime", "react/jsx-dev-runtime", "react-dom/client"],
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

function generateRendererModule(scan: PageScanResult, pagesDir: string, isDev: boolean): string {
  // In dev mode, inject the React Refresh preamble as an inline script.
  // SSR-generated HTML bypasses Vite's transformIndexHtml, so @vitejs/plugin-react
  // can't inject it automatically. Without this, React Fast Refresh breaks and
  // the client entry module fails to load.
  const preambleScript = isDev
    ? `
<script type="module">
  import RefreshRuntime from "/@react-refresh"
  RefreshRuntime.injectIntoGlobalHook(window)
  window.$RefreshReg$ = () => {}
  window.$RefreshSig$ = () => (type) => type
  window.__vite_plugin_react_preamble_installed__ = true
</script>`
    : "";

  return `
import React from "react";
import { renderToString } from "react-dom/server";
import { SharedContext, ErrorsContext, RouterContext } from "@void-x/react/runtime";

${generateComponentManifest(scan, pagesDir)}

const PREAMBLE_SCRIPT = ${JSON.stringify(preambleScript)};

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  // Build layout chain: outermost layout wraps inner layouts wrapping the page
  let element = React.createElement(PageComponent, pageObj.props);
  for (let i = layoutComponents.length - 1; i >= 0; i--) {
    element = React.createElement(layoutComponents[i], null, element);
  }

  // Wrap in context providers
  element = React.createElement(
    SharedContext.Provider,
    { value: pageObj.shared || {} },
    React.createElement(
      ErrorsContext.Provider,
      { value: pageObj.errors || {} },
      React.createElement(
        RouterContext.Provider,
        { value: null },
        element
      )
    )
  );

  const html = renderToString(element);
  const pageData = escapeAttr(JSON.stringify(pageObj));

  return \`<!doctype html>
<html>
<head>\${PREAMBLE_SCRIPT}\${assetTags.head}</head>
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
import React, { useSyncExternalStore } from "react";
import { hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SharedContext, ErrorsContext, RouterContext } from "@void-x/react/runtime";

const VIEW_TRANSITIONS_ENABLED = ${!!viewTransitions};

${generateComponentManifest(scan, pagesDir)}

// --- Module-level store ---
let state = {
  component: null,
  props: {},
  layouts: [],
  shared: {},
  errors: {},
};

const listeners = new Set();
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot() {
  return state;
}
function setState(partial) {
  state = { ...state, ...partial };
  for (const l of listeners) l();
}

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
export const router = {
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
    const [comp, layouts] = await Promise.all([
      resolveComponent(pageData.component),
      resolveLayouts(pageData.component),
    ]);

    const applyUpdate = () => {
      setState({
        component: comp,
        props: pageData.props,
        layouts,
        shared: { ...state.shared, ...(pageData.shared || {}) },
        errors: pageData.errors || {},
      });
    };

    const useTransition = options.viewTransition ?? VIEW_TRANSITIONS_ENABLED;
    if (useTransition && document.startViewTransition) {
      document.startViewTransition(() => {
        flushSync(applyUpdate);
      });
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
  const snap = useSyncExternalStore(subscribe, getSnapshot);

  if (!snap.component) return null;

  // Build layout chain
  let element = React.createElement(snap.component, snap.props);
  for (let i = snap.layouts.length - 1; i >= 0; i--) {
    element = React.createElement(snap.layouts[i], null, element);
  }

  return React.createElement(
    SharedContext.Provider,
    { value: snap.shared },
    React.createElement(
      ErrorsContext.Provider,
      { value: snap.errors },
      React.createElement(
        RouterContext.Provider,
        { value: router },
        element
      )
    )
  );
}

// --- Initialize ---
const appEl = document.getElementById("app");
const initialPageData = JSON.parse(appEl.getAttribute("data-page"));

const [initialComp, initialLayouts] = await Promise.all([
  resolveComponent(initialPageData.component),
  resolveLayouts(initialPageData.component),
]);

state = {
  component: initialComp,
  props: initialPageData.props,
  layouts: initialLayouts,
  shared: initialPageData.shared || {},
  errors: initialPageData.errors || {},
};

hydrateRoot(appEl, React.createElement(App));
appEl.setAttribute("data-hydrated", "true");

window.addEventListener("popstate", () => {
  router.visit(window.location.pathname + window.location.search, { preserveState: true });
});
`;
}
