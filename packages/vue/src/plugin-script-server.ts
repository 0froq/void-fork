import type { Plugin } from "vite";

const SCRIPT_SERVER_RE = /<script\s+server\b[^>]*>([\s\S]*?)<\/script>/;

export function scriptServerPlugin(pagesDir: string): Plugin {
  // Map from .vue file ID → extracted server block content
  const serverBlocks = new Map<string, string>();

  return {
    name: "vite-cloud-vue:script-server",
    enforce: "pre",

    transform(code, id) {
      if (!id.endsWith(".vue")) return;
      // Only process files under pages/
      if (!id.startsWith(pagesDir)) return;

      const match = code.match(SCRIPT_SERVER_RE);
      if (!match) return;

      // Store extracted content
      serverBlocks.set(id, match[1]);

      // Strip the <script server> block from the SFC
      const cleaned = code.replace(SCRIPT_SERVER_RE, "");
      return { code: cleaned, map: null };
    },

    resolveId(id) {
      // When the core tries to import "pages/foo.vue?server",
      // resolve it as a virtual module if we have the extracted content
      if (id.endsWith("?server")) {
        const vuePath = id.slice(0, -7); // strip ?server
        if (serverBlocks.has(vuePath)) {
          return "\0" + id;
        }
      }
    },

    load(id) {
      if (id.startsWith("\0") && id.endsWith("?server")) {
        const vuePath = id.slice(1, -7);
        return serverBlocks.get(vuePath) ?? null;
      }
    },
  };
}
