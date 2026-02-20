import type { Plugin } from "vite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { scanPages } from "vite-cloud/pages";
import type { PageScanResult } from "vite-cloud/pages";
import { generateComponentManifest } from "./pages-manifest";

const RENDERER_ID = "virtual:vite-cloud-pages-renderer";
const CLIENT_ENTRY_ID = "virtual:vite-cloud-pages-client";

export function pagesPlugin(pagesDir: string): Plugin {
  let pageScan: PageScanResult | null = null;
  const root = dirname(pagesDir);

  return {
    name: "vite-cloud-vue:pages",

    async buildStart() {
      if (existsSync(pagesDir)) {
        pageScan = await scanPages(root);
      }
    },

    resolveId(id) {
      if (id === RENDERER_ID) return "\0" + RENDERER_ID;
      if (id === CLIENT_ENTRY_ID) return "\0" + CLIENT_ENTRY_ID;
    },

    load(id) {
      if (id === "\0" + RENDERER_ID) {
        if (!pageScan) return "export function renderPage() { throw new Error('No pages found'); }";
        return generateRendererModule(pageScan, pagesDir);
      }
      if (id === "\0" + CLIENT_ENTRY_ID) {
        if (!pageScan) return "";
        return generateClientEntry(pageScan, pagesDir);
      }
    },

    config(_, env) {
      if (!existsSync(pagesDir)) return;
      if (env.command !== "build") return;

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
import { createSSRApp, h, reactive, provide } from "vue";
import { renderToString } from "vue/server-renderer";

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

  const app = createSSRApp({
    setup() {
      provide("__vc_shared", reactive(pageObj.shared || {}));
      provide("__vc_errors", reactive(pageObj.errors || {}));
      provide("__vc_router", null);
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
  const pageData = escapeAttr(JSON.stringify(pageObj));

  return \`<!doctype html>
<html>
<head>\${assetTags.head}</head>
<body>
  <div id="app" data-page="\${pageData}">\${html}</div>
  \${assetTags.body}
</body>
</html>\`;
}
`;
}

function generateClientEntry(scan: PageScanResult, pagesDir: string): string {
  return `
import { createSSRApp, h, ref, reactive, provide, shallowRef, watch } from "vue";

${generateComponentManifest(scan, pagesDir)}

const initialPageData = JSON.parse(
  document.getElementById("app").getAttribute("data-page")
);

const page = ref(initialPageData);
const shared = reactive(initialPageData.shared || {});
const errors = reactive(initialPageData.errors || {});

async function resolveComponent(id) {
  const loader = components[id];
  if (!loader) throw new Error("Unknown page component: " + id);
  return (await loader()).default;
}

async function resolveLayouts(componentId) {
  const ids = layoutTree[componentId] || [];
  return Promise.all(ids.map(async (id) => (await components[id]()).default));
}

export const router = {
  async visit(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = { "X-Inertia": "true", "Accept": "application/json" };
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

    page.value = pageData;
    Object.assign(shared, pageData.shared || {});

    // Clear old errors, assign new ones
    for (const key of Object.keys(errors)) delete errors[key];
    Object.assign(errors, pageData.errors || {});

    if (!options.preserveState) {
      window.history.pushState({}, "", pageData.url);
    }
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

const currentComponent = shallowRef(null);
const currentLayouts = shallowRef([]);
const currentProps = ref(initialPageData.props);

async function updatePage(pageData) {
  currentComponent.value = await resolveComponent(pageData.component);
  currentLayouts.value = await resolveLayouts(pageData.component);
  currentProps.value = pageData.props;
}

await updatePage(initialPageData);

watch(page, (newPage) => {
  updatePage(newPage);
});

const app = createSSRApp({
  setup() {
    provide("__vc_shared", shared);
    provide("__vc_errors", errors);
    provide("__vc_router", router);

    return () => {
      if (!currentComponent.value) return null;
      let vnode = h(currentComponent.value, currentProps.value);
      for (let i = currentLayouts.value.length - 1; i >= 0; i--) {
        const inner = vnode;
        vnode = h(currentLayouts.value[i], null, { default: () => inner });
      }
      return vnode;
    };
  }
});

app.mount("#app");

// Intercept same-origin <a> clicks for SPA navigation
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[href]");
  if (!link) return;
  // Skip if modifier keys or non-left click
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  // Skip external links
  const url = new URL(link.href, window.location.origin);
  if (url.origin !== window.location.origin) return;
  // Skip links with target attribute
  if (link.target && link.target !== "_self") return;
  // Skip download links
  if (link.hasAttribute("download")) return;
  // Skip links that opt out
  if (link.dataset.noRouter !== undefined) return;

  e.preventDefault();
  router.visit(url.pathname + url.search);
});

window.addEventListener("popstate", () => {
  router.visit(window.location.pathname + window.location.search, { preserveState: true });
});
`;
}
