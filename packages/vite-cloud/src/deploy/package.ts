import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { InferredBindings } from "../inference/walk";
import type { DeployManifest } from "./types";

/**
 * Package the build output into a FormData ready for upload.
 *
 * Build output structure:
 *   dist/
 *     <workerDir>/     ← worker output (index.js + chunks)
 *     client/          ← static SPA assets
 */
export function packageBuild(
  distDir: string,
  workerDirName: string,
  bindings: InferredBindings,
): FormData {
  const formData = new FormData();

  // Build manifest from inferred bindings
  const manifest: DeployManifest = { bindings: {} };
  if (bindings.needsD1) manifest.bindings.d1 = ["DB"];
  if (bindings.needsKV) manifest.bindings.kv = ["KV"];
  if (bindings.needsR2) manifest.bindings.r2 = ["STORAGE"];
  formData.append("manifest", JSON.stringify(manifest));

  // Add worker files
  const workerDir = join(distDir, workerDirName);
  const workerFiles = collectFiles(workerDir);
  for (const filePath of workerFiles) {
    const relativePath = relative(workerDir, filePath);
    // Skip wrangler.json — platform manages worker config
    if (relativePath === "wrangler.json") continue;
    const content = readFileSync(filePath);
    formData.append(`worker:${relativePath}`, new Blob([content]), relativePath);
  }

  // Add client assets
  const clientDir = join(distDir, "client");
  try {
    const clientFiles = collectFiles(clientDir);
    for (const filePath of clientFiles) {
      const relativePath = relative(clientDir, filePath);
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch {
    // No client directory — API-only project
  }

  return formData;
}

/**
 * Recursively collect all file paths in a directory.
 */
function collectFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}
