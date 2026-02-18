import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { InferredBindings } from "../inference/walk";
import type { MigrationFile } from "../migrations/validate";
import type { DeployManifest, HeaderRule, ScheduleMeta } from "./types";

/**
 * Compute SHA-256 hex digests for all files in a directory.
 */
export function computeAssetHashes(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const filePath of collectFiles(dir)) {
    const rel = relative(dir, filePath);
    hashes[rel] = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }
  return hashes;
}

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
  migrations?: MigrationFile[],
  schedules?: ScheduleMeta[],
  ssr?: boolean,
  framework?: boolean,
  neededPaths?: Set<string>,
  assetHashes?: Record<string, string>,
  headers?: HeaderRule[],
  revalidate?: number | Record<string, number>,
): FormData {
  const formData = new FormData();

  // Build manifest from inferred bindings
  const manifest: DeployManifest = { bindings: {} };
  if (bindings.needsD1) manifest.bindings.d1 = ["DB"];
  if (bindings.needsKV) manifest.bindings.kv = ["KV"];
  if (bindings.needsR2) manifest.bindings.r2 = ["STORAGE"];

  // Add migration metadata to manifest + SQL content as FormData entries
  if (migrations && migrations.length > 0) {
    manifest.migrations = migrations.map((m) => ({
      name: m.name,
      destructive: m.destructive,
    }));
    for (const m of migrations) {
      formData.append(`migration:${m.name}`, new Blob([m.sql]), m.name);
    }
  }

  if (schedules && schedules.length > 0) {
    manifest.schedules = schedules;
  }

  if (ssr) {
    manifest.ssr = true;
  }

  if (framework) {
    manifest.framework = true;
  }

  if (assetHashes) {
    manifest.assetHashes = assetHashes;
  }

  if (revalidate != null && revalidate !== 0) {
    manifest.revalidate = revalidate;
  }

  if (headers) {
    manifest.headers = headers;
  }

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

  // Add client assets (only needed paths when filtering)
  const clientDir = join(distDir, "client");
  try {
    const clientFiles = collectFiles(clientDir);
    for (const filePath of clientFiles) {
      const relativePath = relative(clientDir, filePath);
      if (neededPaths && !neededPaths.has(relativePath)) continue;
      const content = readFileSync(filePath);
      formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
    }
  } catch {
    // No client directory — API-only project
  }

  return formData;
}

/**
 * Package a static build (no worker) into a FormData ready for upload.
 */
export function packageStaticBuild(
  outputDir: string,
  mode: "spa" | "ssg",
  neededPaths?: Set<string>,
  assetHashes?: Record<string, string>,
  headers?: HeaderRule[],
): FormData {
  const formData = new FormData();

  const manifest: DeployManifest = { bindings: {}, static: mode };
  if (assetHashes) {
    manifest.assetHashes = assetHashes;
  }
  if (headers) {
    manifest.headers = headers;
  }
  formData.append("manifest", JSON.stringify(manifest));

  const files = collectFiles(outputDir);
  for (const filePath of files) {
    const relativePath = relative(outputDir, filePath);
    if (neededPaths && !neededPaths.has(relativePath)) continue;
    const content = readFileSync(filePath);
    formData.append(`asset:${relativePath}`, new Blob([content]), relativePath);
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
