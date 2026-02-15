import { readFileSync } from "node:fs";
import { globSync } from "tinyglobby";
import { join } from "node:path";
import { inferBindingsFromSource, mergeBindings, type InferredBindings } from "./inference/walk";
import { getSsrServerEntryPath } from "./ssr/entry";

export interface InferenceOptions {
  /** Explicit binding overrides — takes precedence over inference */
  bindings?: {
    db?: boolean;
    kv?: boolean;
    storage?: boolean;
  };
}

/**
 * Synchronously infer which Cloudflare bindings the project needs
 * by scanning route/middleware files and optional src/main.ssr.ts with oxc-parser.
 *
 * This runs once when viteCloud() is called (before plugins initialize),
 * so results are available to configure the Cloudflare plugin.
 */
export function inferProjectBindings(root: string, options?: InferenceOptions): InferredBindings {
  // If user provided explicit overrides, use those
  if (options?.bindings) {
    return {
      needsD1: options.bindings.db ?? false,
      needsKV: options.bindings.kv ?? false,
      needsR2: options.bindings.storage ?? false,
    };
  }

  const dirs = ["routes", "middleware"];
  const allBindings: InferredBindings[] = [];

  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let files: string[];
    try {
      files = globSync("**/*.{ts,mts,js,mjs}", { cwd: dirPath, absolute: true });
    } catch {
      continue;
    }

    for (const file of files) {
      const code = readFileSync(file, "utf-8");
      const filename = file.split("/").pop()!;
      allBindings.push(inferBindingsFromSource(code, filename));
    }
  }

  const ssrEntry = getSsrServerEntryPath(root);
  if (ssrEntry) {
    const code = readFileSync(ssrEntry, "utf-8");
    const filename = ssrEntry.split("/").pop() ?? "main.ssr.ts";
    allBindings.push(inferBindingsFromSource(code, filename));
  }

  return mergeBindings(allBindings);
}
