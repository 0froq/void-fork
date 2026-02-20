import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, type Plugin } from "vite";
import { cloudflare, type WorkerConfig } from "@cloudflare/vite-plugin";
import { routingPlugin } from "./plugin-routing";
import { migrationPlugin } from "./plugin-migration";
import { dbTypesPlugin } from "./plugin-db-types";
import {
  inferProjectBindings,
  detectFramework,
  FRAMEWORK_SCAN_DIRS,
  type Framework,
} from "./plugin-inference";
import { scanJobsSync } from "./crons/scan";
import { scanQueuesSync } from "./queues/scan";
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

  // Infer bindings synchronously from source files
  const scanDirs = framework ? FRAMEWORK_SCAN_DIRS : undefined;
  const inferenceOptions = config.bindings ? { bindings: config.bindings } : undefined;
  const bindings = inferProjectBindings(root, inferenceOptions, scanDirs);

  // Phase 1: Determine auth providers from imports (sync, at plugin creation)
  // Explicit config takes precedence over auto-detection.
  let authProviders: AuthProvider[] | null;
  if (config.auth !== undefined) {
    authProviders = normalizeAuth(config.auth);
  } else {
    authProviders = bindings.needsAuth ? ["email"] : null;
  }

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

  // Scan queues early so mergeBindings can reference them in both branches.
  // Framework mode skips queue scanning (empty array).
  const queues = framework ? [] : scanQueuesSync(root);

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

    // Queues — add producer + consumer bindings for local dev
    if (queues.length > 0) {
      (result as Record<string, unknown>).queues = {
        producers: queues.map((q) => ({ queue: q.name, binding: q.bindingName })),
        consumers: queues.map((q) => ({
          queue: q.name,
          ...(q.maxBatchSize != null && { max_batch_size: q.maxBatchSize }),
          ...(q.maxBatchTimeout != null && { max_batch_timeout: q.maxBatchTimeout }),
        })),
      };
    }

    return result as Partial<WorkerConfig>;
  }

  // Plugin that loads .env files and merges them into workerConfig.vars.
  // Runs before the Cloudflare plugin so vars are available as worker bindings.
  // Phase 2: Also auto-detects OAuth providers from env vars.
  const envPlugin: Plugin = {
    name: "vite-cloud:env",
    config(_, { mode }) {
      const env = loadEnv(mode, root, "");
      workerConfig.vars = { ...(workerConfig.vars as Record<string, string> | undefined), ...env };

      // Auto-detect OAuth providers from env vars (only if not explicitly configured)
      if (config.auth === undefined) {
        if (env.GITHUB_OAUTH_ID) {
          authProviders ??= [];
          if (!authProviders.includes("github")) authProviders.push("github");
        }
        if (env.GOOGLE_OAUTH_ID) {
          authProviders ??= [];
          if (!authProviders.includes("google")) authProviders.push("google");
        }
      }
    },
    configureServer(server) {
      if (config.auth !== undefined) return;
      let envHintShown = false;
      const check = (path: string) => {
        if (envHintShown) return;
        if (!path.split("/").pop()?.startsWith(".env")) return;
        try {
          const content = readFileSync(path, "utf-8");
          const providers: string[] = [];
          if (/^GITHUB_OAUTH_ID=/m.test(content) && !authProviders?.includes("github"))
            providers.push("GitHub");
          if (/^GOOGLE_OAUTH_ID=/m.test(content) && !authProviders?.includes("google"))
            providers.push("Google");
          if (providers.length > 0) {
            envHintShown = true;
            server.config.logger.warn(
              `[vite-cloud] ${providers.join(" and ")} OAuth credentials detected — restart to enable.`,
            );
          }
        } catch {}
      };
      server.watcher.on("change", check);
      server.watcher.on("add", check);
    },
  };

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
      envPlugin,
      dbTypesPlugin(root, false),
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
  // Add nodejs_als for AsyncLocalStorage (used by isomorphic fetch context threading)
  const existingFlags = (workerConfig.compatibility_flags as string[] | undefined) ?? [];
  if (!existingFlags.includes("nodejs_als") && !existingFlags.includes("nodejs_compat")) {
    workerConfig.compatibility_flags = [...existingFlags, "nodejs_als"];
  }

  const jobs = scanJobsSync(root);
  const ssrEntry = validateSsrEntry(root);
  const hasPages = existsSync(join(root, "pages"));

  workerConfig.main = join(root, ".vite-cloud", "entry.ts");

  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: jobs.flatMap((job) => job.crons),
    };
  }

  if (ssrEntry || hasPages) {
    workerConfig.assets = {
      binding: "ASSETS",
      // Route document/API requests to the worker for SSR/Pages. Static assets
      // (hashed files in /assets/) bypass the worker and are served directly
      // from the edge. Dev-only exclusions let Vite serve source modules.
      run_worker_first: [
        "/**",
        "!/assets/*",
        "!/@*",
        "!/src/*",
        "!/node_modules/*",
        ...(hasPages ? ["!/pages/*"] : []),
      ],
    };
  }

  return [
    envPlugin,
    routingPlugin(root, { getAuth: () => authProviders, autoDetect: config.auth === undefined }),
    dbTypesPlugin(root, true),
    migrationPlugin(root),
    ...cloudflare({
      ...inspectorPortOption,
      persistState: { path: join(root, ".vite-cloud") },
      config: mergeBindings,
    }),
  ];
}

// Re-export runtime types and functions
export {
  defineHandler,
  defineMiddleware,
  defineScheduled,
  defineRender,
  defineQueue,
} from "./runtime/handler";
export type {
  CloudContext,
  CloudEnv,
  RenderAssetTags,
  TypedHandler,
  TypedQueueHandler,
  QueueBatch,
  QueueMessage,
} from "./runtime/handler";
export type { ValidatorSlots, HandlerInput } from "./runtime/validator";
export type { AuthUser } from "./runtime/auth";
export type { QueueMap } from "./runtime/queues";

type AuthProvider = import("./config").AuthProvider;
