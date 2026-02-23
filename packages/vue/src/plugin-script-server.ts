import type { Plugin } from "vite";

const SCRIPT_SERVER_RE = /<script\s+server\b[^>]*>([\s\S]*?)<\/script>/;

const TYPE_START_RE = /^(export\s+)?(interface\s|type\s\w+\s*[=<])/;
const IMPORT_TYPE_RE = /^import\s+type\s/;

/**
 * Given the inner content of a `<script server>` block, returns a version
 * where runtime lines are blanked but type declarations are preserved.
 * Returns `null` if no type declarations are found.
 */
export function extractTypeDeclarations(content: string): string | null {
  const lines = content.split("\n");
  const kept = new Array<boolean>(lines.length).fill(false);
  let braceDepth = 0;
  let inType = false;
  let foundAny = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (inType) {
      kept[i] = true;
      for (const ch of lines[i]) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0) {
        inType = false;
        braceDepth = 0;
      }
      continue;
    }

    if (TYPE_START_RE.test(trimmed) || IMPORT_TYPE_RE.test(trimmed)) {
      foundAny = true;
      kept[i] = true;

      // Check if this opens a multi-line block
      for (const ch of lines[i]) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }
      if (braceDepth > 0) {
        inType = true;
      } else {
        braceDepth = 0;
      }
    }
  }

  if (!foundAny) return null;

  return lines.map((line, i) => (kept[i] ? line : "")).join("\n");
}

export function scriptServerPlugin(pagesDir: string): Plugin {
  // Map from .vue file ID → extracted server block content
  const serverBlocks = new Map<string, string>();

  return {
    name: "void-vue:script-server",
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

        // Try to preserve type declarations for <script setup>
        const typeOnly = extractTypeDeclarations(match[1]);

        let cleaned: string;
        if (typeOnly) {
          // Replace <script server ...> with <script ...> (strip `server` attribute)
          // so the Vue SFC compiler sees a normal <script> block with type-only content
          cleaned = code.replace(SCRIPT_SERVER_RE, (m) => {
            const openTag = m.slice(0, m.indexOf(">") + 1).replace(/\s+server\b/, "");
            const closeTag = "</script>";
            return openTag + typeOnly + closeTag;
          });
        } else {
          // No types found — blank the entire block
          cleaned = code.replace(SCRIPT_SERVER_RE, (m) => "\n".repeat(m.split("\n").length - 1));
        }

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
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: /^\0.*\?server$/ },
      handler(id) {
        const vuePath = id.slice(1, -7);
        return serverBlocks.get(vuePath) ?? null;
      },
    },
  };
}
