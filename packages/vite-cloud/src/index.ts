import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { cloudflare, type WorkerConfig } from "@cloudflare/vite-plugin";
import { routingPlugin } from "./plugin-routing";
import { migrationPlugin } from "./plugin-migration";
import {
  inferProjectBindings,
  detectFramework,
  FRAMEWORK_SCAN_DIRS,
  type Framework,
} from "./plugin-inference";
import { scanJobsSync } from "./jobs/scan";
import { validateSsrEntry } from "./ssr/entry";
import { readConfig, normalizeAuth } from "./config";

export type { AuthProvider } from "./config";

/** Server entry module for each supported framework. */
const FRAMEWORK_ENTRIES: Record<Framework, string> = {
  "tanstack-start": "@tanstack/react-start/server-entry",
  "react-router": "react-router/server-entry",
};

/** Check whether a binding name already exists in a resolved bindings array. */
function hasBinding(list: readonly { binding: string }[] | undefined, name: string): boolean {
  return Array.isArray(list) && list.some((b) => b.binding === name);
}

/**
 * Vite Cloud plugin — the main entry point.
 *
 * Composes:
 * 1. Routing plugin (file-based routing from routes/ and middleware/)
 * 2. Migration plugin (auto-apply .sql migrations on dev startup)
 * 3. @cloudflare/vite-plugin (workerd runtime, HMR, builds)
 *
 * Binding inference runs synchronously here so results are available
 * before the Cloudflare plugin initializes.
 *
 * If the user has a `wrangler.json` / `wrangler.toml` in their project root,
 * the Cloudflare plugin reads it and provides the resolved config to our
 * config function. Bindings already defined there (with real IDs for
 * production deployment) are preserved — we only add inferred bindings
 * that are missing. This allows `vite build && wrangler deploy` to work
 * for deploying directly to Cloudflare without the Vite Cloud platform.
 */
export default function viteCloud(): Plugin[] {
  // Resolve root relative to CWD — this runs at config time
  const root = process.cwd();
  const config = readConfig(root);
  const framework = detectFramework(root);
  const authProviders = normalizeAuth(config.auth);

  // Infer bindings synchronously from source files
  const scanDirs = framework ? FRAMEWORK_SCAN_DIRS : undefined;
  const inferenceOptions = config.bindings ? { bindings: config.bindings } : undefined;
  const bindings = inferProjectBindings(root, inferenceOptions, scanDirs);

  // Core worker config — always set by viteCloud (main, triggers, assets).
  // Bindings are handled separately in the config function below.
  const workerConfig: Record<string, unknown> = {};

  // Merge curated wrangler fields from vite-cloud.json
  if (config.wrangler?.compatibility_date) {
    workerConfig.compatibility_date = config.wrangler.compatibility_date;
  }
  if (config.wrangler?.compatibility_flags) {
    workerConfig.compatibility_flags = config.wrangler.compatibility_flags;
  }
  if (config.wrangler?.vars) {
    workerConfig.vars = config.wrangler.vars;
  }

  const inspectorPortEnv = process.env.VITE_CLOUD_INSPECTOR_PORT;
  const inspectorPort =
    inspectorPortEnv === "false"
      ? false
      : typeof inspectorPortEnv === "string" && inspectorPortEnv.length > 0
        ? Number.parseInt(inspectorPortEnv, 10)
        : undefined;

  const inspectorPortOption: { inspectorPort?: number | false } =
    inspectorPort === false
      ? { inspectorPort: false }
      : typeof inspectorPort === "number"
        ? { inspectorPort }
        : {};

  const outDir = join(root, ".vite-cloud");
  mkdirSync(outDir, { recursive: true });

  // Config function that merges inferred bindings with the resolved config.
  // When the user has a wrangler.json with real binding IDs (for raw CF
  // deployment), those take precedence. We only add placeholder bindings
  // for inferred bindings that are missing from their config.
  // When no wrangler.json exists, resolved config has empty bindings and
  // all inferred bindings are added — matching the previous behavior.
  function mergeBindings(resolved: WorkerConfig): Partial<WorkerConfig> {
    const result: Record<string, unknown> = { ...workerConfig };

    // D1 — auth requires a DB too
    const d1: Record<string, unknown>[] = [];
    if ((bindings.needsD1 || authProviders) && !hasBinding(resolved.d1_databases, "DB")) {
      d1.push({ binding: "DB", database_name: "default", database_id: "local" });
    }
    if (d1.length > 0) {
      result.d1_databases = [...(resolved.d1_databases ?? []), ...d1];
    }

    // KV — auth needs AUTH_KV for sessions
    const kv: { binding: string; id: string }[] = [];
    if (bindings.needsKV && !hasBinding(resolved.kv_namespaces, "KV")) {
      kv.push({ binding: "KV", id: "local" });
    }
    if (authProviders && !hasBinding(resolved.kv_namespaces, "AUTH_KV")) {
      kv.push({ binding: "AUTH_KV", id: "auth-local" });
    }
    if (kv.length > 0) {
      result.kv_namespaces = [...(resolved.kv_namespaces ?? []), ...kv];
    }

    // R2
    if (bindings.needsR2 && !hasBinding(resolved.r2_buckets, "STORAGE")) {
      result.r2_buckets = [
        ...(resolved.r2_buckets ?? []),
        { binding: "STORAGE", bucket_name: "default" },
      ];
    }

    return result as Partial<WorkerConfig>;
  }

  if (framework) {
    // Framework mode: no routing plugin, CF plugin uses viteEnvironment.
    // The CF plugin needs `main` to create a proper worker environment
    // (without it, the worker is treated as "assets-only" and cloudflare:*
    // modules are not externalized during the SSR build).
    workerConfig.main = FRAMEWORK_ENTRIES[framework];
    // Framework mode requires nodejs_compat — merge with any user-specified flags
    const existingFlags = (workerConfig.compatibility_flags as string[] | undefined) ?? [];
    if (!existingFlags.includes("nodejs_compat")) {
      workerConfig.compatibility_flags = [...existingFlags, "nodejs_compat"];
    }

    return [
      migrationPlugin(root),
      ...cloudflare({
        ...inspectorPortOption,
        persistState: { path: join(root, ".vite-cloud") },
        viteEnvironment: { name: "ssr" },
        config: mergeBindings,
      }),
    ];
  }

  // Default mode: full Hono routing + generated entry
  const jobs = scanJobsSync(root);
  const ssrEntry = validateSsrEntry(root);

  workerConfig.main = join(root, ".vite-cloud", "entry.ts");

  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: jobs.map((job) => job.cron),
    };
  }

  if (ssrEntry) {
    workerConfig.assets = {
      binding: "ASSETS",
      // Route HTML/document requests to the worker first for SSR, but let Vite dev
      // internals and source module requests bypass to the asset worker.
      run_worker_first: ["/**", "!/@*", "!/src/*", "!/node_modules/*"],
    };
  }

  return [
    routingPlugin(root, { auth: authProviders }),
    migrationPlugin(root),
    ...cloudflare({
      ...inspectorPortOption,
      persistState: { path: join(root, ".vite-cloud") },
      config: mergeBindings,
    }),
  ];
}

// Re-export runtime types and functions
export { defineHandler, defineMiddleware, defineJob, defineRender } from "./runtime/handler";
export type { CloudContext, CloudEnv, RenderAssetTags, TypedHandler } from "./runtime/handler";
export type { ValidatorSlots, HandlerInput } from "./runtime/validator";
export type { AuthUser } from "./runtime/auth";
export { fetch, FetchError } from "./runtime/fetch";
