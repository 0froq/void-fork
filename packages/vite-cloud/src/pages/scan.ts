import { existsSync, readFileSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { glob } from "tinyglobby";
import { parseRouteFilename } from "../router/parse-filename";
import type { PageDefinition, LayoutDefinition, PageScanResult } from "./types";

const COMPONENT_EXTENSIONS = ["vue", "tsx", "jsx", "svelte"];
const SERVER_EXTENSIONS = ["ts", "tsx", "js", "mjs", "mts"];
const SCRIPT_SERVER_CONTENT_RE = /<script\s+server\b[^>]*>([\s\S]*?)<\/script>/;
const PAGES_EXPORT_RE = /export\s+(?:const|function|async\s+function)\s+(loader|action)\b/g;
const REVALIDATE_RE = /export\s+const\s+revalidate\s*=\s*(\d+)\s*;/;

export async function scanPages(root: string): Promise<PageScanResult> {
  const pagesDir = join(root, "pages");
  if (!existsSync(pagesDir)) return { pages: [], layouts: [] };

  const pattern = `**/*.{${COMPONENT_EXTENSIONS.join(",")}}`;
  const files = await glob(pattern, { cwd: pagesDir, absolute: false });

  const pages: PageDefinition[] = [];
  const layouts: LayoutDefinition[] = [];

  for (const file of files) {
    // Skip files starting with _ in any segment
    if (file.split("/").some((s) => s.startsWith("_"))) continue;

    const ext = extname(file);
    const base = basename(file, ext);

    // Layout files
    if (base === "layout") {
      const dir = dirname(file);
      layouts.push({
        directory: dir === "." ? "" : dir,
        filePath: file,
      });
      continue;
    }

    // Page files — parse as route
    // parseRouteFilename only strips .ts/.js/.mts/.mjs — convert component
    // extension to .ts so the parser handles it correctly.
    const route = parseRouteFilename(file.replace(ext, ".ts"));
    const componentId =
      file
        .replace(ext, "")
        .replace(/\/index$/, "")
        .replace(/^index$/, "") || "index";

    // Check for companion .server.ts
    let serverPath: string | null = null;
    let methods: string[] = [];
    let revalidate: number | undefined;
    for (const serverExt of SERVER_EXTENSIONS) {
      const candidate = file.replace(ext, `.server.${serverExt}`);
      if (existsSync(join(pagesDir, candidate))) {
        serverPath = candidate;
        const content = readFileSync(join(pagesDir, candidate), "utf-8");
        for (const m of content.matchAll(PAGES_EXPORT_RE)) {
          methods.push(m[1]);
        }
        const revalidateMatch = content.match(REVALIDATE_RE);
        if (revalidateMatch) {
          revalidate = Number(revalidateMatch[1]);
        }
        break;
      }
    }

    // Check for inline <script server> (only .vue files)
    let hasInlineServer = false;
    let inlineServerContent: string | undefined;
    if (file.endsWith(".vue") && !serverPath) {
      const content = readFileSync(join(pagesDir, file), "utf-8");
      const blockMatch = content.match(SCRIPT_SERVER_CONTENT_RE);
      if (blockMatch) {
        hasInlineServer = true;
        inlineServerContent = blockMatch[1];
        // Detect loader/action exports from the inline block
        for (const m of inlineServerContent.matchAll(PAGES_EXPORT_RE)) {
          methods.push(m[1]);
        }
      }
    }

    pages.push({
      pattern: route.pattern,
      params: route.params,
      catchAll: route.catchAll,
      componentPath: file,
      serverPath,
      hasInlineServer,
      inlineServerContent,
      methods,
      componentId,
      revalidate,
    });
  }

  // Sort: static before dynamic, catch-all last
  pages.sort((a, b) => {
    if (a.catchAll !== b.catchAll) return a.catchAll ? 1 : -1;
    const aDynamic = a.pattern.includes(":");
    const bDynamic = b.pattern.includes(":");
    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
    return a.pattern.localeCompare(b.pattern);
  });

  return { pages, layouts };
}

/** Resolve the layout chain for a component (innermost last) */
export function resolveLayoutChain(
  componentId: string,
  layouts: LayoutDefinition[],
): LayoutDefinition[] {
  const parts = componentId.split("/");
  const chain: LayoutDefinition[] = [];

  // Check root layout
  const root = layouts.find((l) => l.directory === "");
  if (root) chain.push(root);

  // Check each directory level
  let dir = "";
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    const layout = layouts.find((l) => l.directory === dir);
    if (layout) chain.push(layout);
  }

  return chain;
}
