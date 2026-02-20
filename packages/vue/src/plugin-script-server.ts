import type { Plugin } from "vite";

const SCRIPT_SERVER_RE = /<script\s+server\b[^>]*>([\s\S]*?)<\/script>/;

export function scriptServerPlugin(pagesDir: string): Plugin {
  // Map from .vue file ID → extracted server block content
  const serverBlocks = new Map<string, string>();

  return {
    name: "vite-cloud-vue:script-server",
    enforce: "pre",

    transform: {
      filter: {
        id: { include: /\.vue$/, exclude: /node_modules/ },
        code: /<script\s+server\b/,
      },
      handler(code, id) {
        // Only process files under pages/
        if (!id.startsWith(pagesDir)) return;

        const match = code.match(SCRIPT_SERVER_RE);
        if (!match) return;

        // Store extracted content
        serverBlocks.set(id, match[1]);

        // Strip the <script server> block, preserving line positions
        const cleaned = code.replace(SCRIPT_SERVER_RE, (m) =>
          "\n".repeat(m.split("\n").length - 1),
        );
        return { code: cleaned, map: { mappings: "" } };
      },
    },

    resolveId: {
      filter: { id: /\?server$/ },
      handler(id) {
        const vuePath = id.slice(0, -7); // strip ?server
        if (serverBlocks.has(vuePath)) {
          return "\0" + id;
        }
      },
    },

    load: {
      filter: { id: /^\0.*\?server$/ },
      handler(id) {
        const vuePath = id.slice(1, -7);
        return serverBlocks.get(vuePath) ?? null;
      },
    },
  };
}
