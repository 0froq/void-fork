import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { routingPlugin } from "./plugin-routing";
import { migrationPlugin } from "./plugin-migration";
import {
  inferProjectBindings,
  detectFramework,
  FRAMEWORK_SCAN_DIRS,
  type InferenceOptions,
  type Framework,
} from "./plugin-inference";
import { scanJobsSync } from "./jobs/scan";
import { validateSsrEntry } from "./ssr/entry";

/** Supported authentication providers. */
export type AuthProvider = "github" | "google" | "email";

/** Server entry module for each supported framework. */
const FRAMEWORK_ENTRIES: Record<Framework, string> = {
  "tanstack-start": "@tanstack/react-start/server-entry",
  "react-router": "react-router/server-entry",
};

/** Options for the {@link viteCloud} plugin. */
export interface ViteCloudOptions extends InferenceOptions {
  /**
   * Enable built-in auth routes and session management.
   *
   * - `true` enables email-only auth.
   * - An array of {@link AuthProvider} names enables specific providers.
   * - `false` / `undefined` disables auth entirely.
   */
  auth?: boolean | AuthProvider[];
}

function normalizeAuth(auth: boolean | AuthProvider[] | undefined): AuthProvider[] | null {
  if (!auth) return null;
  if (auth === true) return ["email"];
  if (auth.length === 0) return null;
  return auth;
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
  const framework = detectFramework(root);
  const authProviders = normalizeAuth(options.auth);

  // Infer bindings synchronously from source files
  const scanDirs = framework ? FRAMEWORK_SCAN_DIRS : undefined;
  const bindings = inferProjectBindings(root, options, scanDirs);

  // Build the worker config with inferred bindings (no main/assets in framework mode)
  const workerConfig: Record<string, unknown> = {};

  // Auth requires D1 (user table) and KV (sessions)
  if (bindings.needsD1 || authProviders) {
    workerConfig.d1_databases = [
      {
        binding: "DB",
        database_name: "default",
        database_id: "local",
      },
    ];
  }

  const kvNamespaces: { binding: string; id: string }[] = [];
  if (bindings.needsKV) {
    kvNamespaces.push({ binding: "KV", id: "local" });
  }
  if (authProviders) {
    kvNamespaces.push({ binding: "AUTH_KV", id: "auth-local" });
  }
  if (kvNamespaces.length > 0) {
    workerConfig.kv_namespaces = kvNamespaces;
  }

  if (bindings.needsR2) {
    workerConfig.r2_buckets = [
      {
        binding: "STORAGE",
        bucket_name: "default",
      },
    ];
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

  if (framework) {
    // Framework mode: no routing plugin, CF plugin uses viteEnvironment.
    // The CF plugin needs `main` to create a proper worker environment
    // (without it, the worker is treated as "assets-only" and cloudflare:*
    // modules are not externalized during the SSR build).
    workerConfig.main = FRAMEWORK_ENTRIES[framework];
    workerConfig.compatibility_flags = ["nodejs_compat"];

    return [
      migrationPlugin(root),
      ...cloudflare({
        ...inspectorPortOption,
        persistState: { path: join(root, ".vite-cloud") },
        viteEnvironment: { name: "ssr" },
        config: workerConfig,
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
      config: workerConfig,
    }),
  ];
}

// Re-export runtime types and functions
export { defineHandler, defineMiddleware, defineJob, defineRender } from "./runtime/handler";
export type { CloudContext, CloudEnv, RenderAssetTags } from "./runtime/handler";
export type { AuthUser } from "./runtime/auth";
