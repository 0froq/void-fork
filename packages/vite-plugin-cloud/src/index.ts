import { join } from "node:path";
import type { Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { routingPlugin } from "./plugin-routing";
import { migrationPlugin } from "./plugin-migration";
import { inferProjectBindings, type InferenceOptions } from "./plugin-inference";

export interface ViteCloudOptions extends InferenceOptions {
  /** Override the routes directory (default: "routes") */
  routesDir?: string;
  /** Override the middleware directory (default: "middleware") */
  middlewareDir?: string;
  /** Override the migrations directory (default: "migrations") */
  migrationsDir?: string;
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
 */
export default function viteCloud(options: ViteCloudOptions = {}): Plugin[] {
  // Resolve root relative to CWD — this runs at config time
  const root = process.cwd();

  // Infer bindings synchronously from source files
  const bindings = inferProjectBindings(root, options);

  // Build the Cloudflare plugin config based on inferred bindings
  const cfBindings: Record<string, unknown> = {};

  if (bindings.needsD1) {
    cfBindings.d1_databases = [
      {
        binding: "DB",
        database_name: "default",
        database_id: "local",
      },
    ];
  }

  if (bindings.needsKV) {
    cfBindings.kv_namespaces = [
      {
        binding: "KV",
        id: "local",
      },
    ];
  }

  if (bindings.needsR2) {
    cfBindings.r2_buckets = [
      {
        binding: "STORAGE",
        bucket_name: "default",
      },
    ];
  }

  return [
    routingPlugin(root),
    migrationPlugin(root),
    cloudflare({
      main: join(root, ".vite-cloud", "entry.ts"),
      persistState: join(root, ".vite-cloud"),
      ...cfBindings,
    }),
  ];
}

// Re-export runtime types and functions
export type { ViteCloudOptions };
export { defineHandler } from "./runtime/handler";
export type { RequestContext } from "./runtime/context";
