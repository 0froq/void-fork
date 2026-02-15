import { join } from "node:path";
import type { Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { routingPlugin } from "./plugin-routing";
import { migrationPlugin } from "./plugin-migration";
import { inferProjectBindings, type InferenceOptions } from "./plugin-inference";
import { scanJobsSync } from "./jobs/scan";
import { validateSsrEntry } from "./ssr/entry";

export type ViteCloudOptions = InferenceOptions;

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
 */
export default function viteCloud(options: ViteCloudOptions = {}): Plugin[] {
  // Resolve root relative to CWD — this runs at config time
  const root = process.cwd();

  // Infer bindings synchronously from source files
  const bindings = inferProjectBindings(root, options);
  const jobs = scanJobsSync(root);
  const ssrEntry = validateSsrEntry(root);

  // Build the worker config with inferred bindings
  const workerConfig: Record<string, unknown> = {
    main: join(root, ".vite-cloud", "entry.ts"),
  };

  if (bindings.needsD1) {
    workerConfig.d1_databases = [
      {
        binding: "DB",
        database_name: "default",
        database_id: "local",
      },
    ];
  }

  if (bindings.needsKV) {
    workerConfig.kv_namespaces = [
      {
        binding: "KV",
        id: "local",
      },
    ];
  }

  if (bindings.needsR2) {
    workerConfig.r2_buckets = [
      {
        binding: "STORAGE",
        bucket_name: "default",
      },
    ];
  }

  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: jobs.map((job) => job.cron),
    };
  }

  if (ssrEntry) {
    workerConfig.assets = {
      binding: "ASSETS",
      // Ensure non-asset route requests are evaluated by the worker first in local dev
      // so SSR entry fallback behaves consistently with production routing.
      run_worker_first: true,
    };
  }

  const inspectorPortEnv = process.env.VITE_CLOUD_INSPECTOR_PORT;
  const inspectorPort =
    inspectorPortEnv === "false"
      ? false
      : typeof inspectorPortEnv === "string" && inspectorPortEnv.length > 0
        ? Number.parseInt(inspectorPortEnv, 10)
        : undefined;

  return [
    routingPlugin(root),
    migrationPlugin(root),
    ...cloudflare({
      ...(inspectorPort === false || Number.isFinite(inspectorPort)
        ? { inspectorPort: inspectorPort === false ? false : inspectorPort }
        : {}),
      persistState: { path: join(root, ".vite-cloud") },
      config: workerConfig,
    }),
  ];
}

// Re-export runtime types and functions
export { defineHandler, defineMiddleware, defineJob } from "./runtime/handler";
export type { CloudContext, CloudEnv } from "./runtime/handler";
