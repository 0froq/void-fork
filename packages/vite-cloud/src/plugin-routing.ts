import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { scanRoutes, type ScanResult } from "./router/scan";
import {
  compileRouteTable,
  compileWorkerEntry,
  compileWorkerClient,
  type CompileOptions,
  type SsrCompileOptions,
} from "./router/compile";
import { generateRouteTypes } from "./codegen/route-types";
import { generateQueueTypes } from "./codegen/queue-types";
import type { AuthProvider } from "./index";
import { inferBindingsFromSource } from "./inference/walk";
import {
  validateSsrEntries,
  SSR_SERVER_ENTRY_RELATIVE_PATHS,
  SSR_CLIENT_ENTRY_RELATIVE_PATHS,
} from "./ssr/entry";

const VIRTUAL_ROUTES_ID = "virtual:vite-cloud-routes";
const VIRTUAL_CLIENT_WORKER_ID = "virtual:vite-cloud-client-worker";
// Rolldown resolveId hook filters currently require RegExp for `id`.
const RESOLVE_ID_FILTER =
  /^(virtual:vite-cloud-(routes|client-worker)|vite-cloud(\/client|\/queues)?)$/;
const LOAD_ID_FILTER = /^virtual:vite-cloud-(routes|client-worker)$/;

/**
 * Vite plugin that provides file-based routing.
 * - Scans routes/ and middleware/ directories
 * - Generates virtual modules for the route table and worker entry
 * - Watches for file changes and triggers HMR
 */
interface RoutingPluginOptions {
  getAuth: () => AuthProvider[] | null;
  autoDetect: boolean;
}

export function routingPlugin(root: string, options: RoutingPluginOptions): Plugin {
  let scan: ScanResult | null = null;
  let ssr: SsrCompileOptions | null = null;
  const routesDir = join(root, "routes");
  const middlewareDir = join(root, "middleware");
  const jobsDir = join(root, "crons");
  const queuesDir = join(root, "queues");
  const srcDir = join(root, "src");
  const ssrEntryAbsPaths = new Set(
    [...SSR_SERVER_ENTRY_RELATIVE_PATHS, ...SSR_CLIENT_ENTRY_RELATIVE_PATHS].map((path) =>
      join(root, path),
    ),
  );

  function writeRouteTypes() {
    if (!scan) return;
    const dts = generateRouteTypes(scan, routesDir, outDir);
    writeFileSync(join(outDir, "routes.d.ts"), dts);
  }

  function writeQueueTypes() {
    if (!scan) return;
    const dts = generateQueueTypes(scan.queues, queuesDir, outDir);
    writeFileSync(join(outDir, "queues.d.ts"), dts);
  }

  async function rescan() {
    scan = await scanRoutes(root);
    const entries = validateSsrEntries(root);
    ssr = entries
      ? {
          serverEntryPath: entries.server.absolutePath,
          clientEntryRelativePath: entries.client.relativePath,
        }
      : null;
  }

  // Pre-resolve all runtime module paths so generated code uses absolute paths.
  // This is necessary because:
  // 1. "vite-cloud" bare import would pull in the entire plugin
  // 2. "hono" is a dep of vite-cloud, not the user's project
  // 3. Virtual modules have no filesystem location for relative resolution
  const resolveFile = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

  const handlerFile = resolveFile("vite-cloud/handler");
  const authClientPath = join(dirname(resolveFile("vite-cloud/client")), "auth-client.mjs");
  const compileOptions: CompileOptions = {
    honoPath: resolveFile("hono"),
    responsePath: resolveFile("vite-cloud/response"),
    reactRefresh: false,
    auth: null,
  };

  // Auth compile options are set up lazily in buildStart (after env plugin
  // has run its config hook and authProviders is fully resolved).
  function resolveAuthCompileOptions(): void {
    const providers = options.getAuth();
    if (!providers) {
      compileOptions.auth = null;
      return;
    }
    const hasEmail = providers.includes("email");
    const hasGitHub = providers.includes("github");
    const hasGoogle = providers.includes("google");
    compileOptions.auth = {
      providers,
      sessionPath: resolveFile("vite-cloud/auth/session"),
      passwordPath: hasEmail ? resolveFile("vite-cloud/auth/password") : null,
      schemaPath: resolveFile("vite-cloud/auth/schema"),
      githubProviderPath: hasGitHub ? resolveFile("@hono/oauth-providers/github") : null,
      googleProviderPath: hasGoogle ? resolveFile("@hono/oauth-providers/google") : null,
    };
  }

  // Generate the entry file and tsconfig eagerly (at plugin creation time,
  // during viteCloud()). The CF plugin needs the `main` file to exist at
  // config resolution time, which is before any hooks like buildStart fire.
  // The tsconfig.json allows users to extend it from their root tsconfig
  // so generated types (.vite-cloud/routes.d.ts) are discovered automatically.
  const outDir = join(root, ".vite-cloud");
  mkdirSync(outDir, { recursive: true });
  // Write initial entry — will be re-written with hasQueues once scan completes
  writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry());

  return {
    name: "vite-cloud:routing",
    enforce: "pre",
    configResolved(config) {
      compileOptions.reactRefresh = config.plugins.some(
        (plugin) =>
          plugin.name === "vite:react-babel" ||
          plugin.name === "vite:react-refresh" ||
          plugin.name === "vite:react-swc",
      );
    },
    config(_, env) {
      const entries = validateSsrEntries(root);
      if (!entries || env.command !== "build") return;

      return {
        build: {
          manifest: true,
          rollupOptions: {
            input: entries.client.absolutePath,
          },
        },
      };
    },

    async buildStart() {
      resolveAuthCompileOptions();
      await rescan();
      writeRouteTypes();
      writeQueueTypes();
      // Re-write entry with queue handler if needed
      writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry(scan!.queues.length > 0));
    },

    resolveId: {
      filter: { id: RESOLVE_ID_FILTER },
      handler(id) {
        if (id === VIRTUAL_ROUTES_ID) {
          return VIRTUAL_ROUTES_ID;
        }
        if (id === VIRTUAL_CLIENT_WORKER_ID) {
          return VIRTUAL_CLIENT_WORKER_ID;
        }
        // Redirect bare "vite-cloud" imports to the lightweight handler
        // subpath to avoid pulling the entire plugin into the Worker bundle.
        if (id === "vite-cloud") {
          return handlerFile;
        }
        // Redirect vite-cloud/queues to the built runtime module
        if (id === "vite-cloud/queues") {
          return resolveFile("vite-cloud/queues");
        }
        // In worker environments, redirect vite-cloud/client to the worker
        // virtual module that calls app.fetch() directly (no HTTP round-trip).
        if (id === "vite-cloud/client" && this.environment?.name !== "client") {
          return VIRTUAL_CLIENT_WORKER_ID;
        }
      },
    },

    load: {
      filter: { id: LOAD_ID_FILTER },
      async handler(id) {
        if (id === VIRTUAL_CLIENT_WORKER_ID) {
          return compileWorkerClient(authClientPath);
        }
        if (id !== VIRTUAL_ROUTES_ID) return;
        if (!scan) await rescan();
        return compileRouteTable(
          scan!,
          routesDir,
          middlewareDir,
          jobsDir,
          queuesDir,
          ssr,
          compileOptions,
        );
      },
    },

    configureServer(devServer) {
      // Watch routes/ and middleware/ for new/removed files
      const watcher = devServer.watcher;
      let authHintShown = false;

      const handleFileChange = async (path: string) => {
        if (
          !path.startsWith(routesDir) &&
          !path.startsWith(middlewareDir) &&
          !path.startsWith(jobsDir) &&
          !path.startsWith(queuesDir) &&
          !path.startsWith(srcDir)
        ) {
          return;
        }

        // Check for auth imports when auth is not currently enabled
        if (options.autoDetect && !options.getAuth() && !authHintShown) {
          try {
            const code = readFileSync(path, "utf-8");
            if (inferBindingsFromSource(code, path.split("/").pop()!).needsAuth) {
              authHintShown = true;
              devServer.config.logger.warn(
                "[vite-cloud] auth import detected — restart to enable auth routes.",
              );
            }
          } catch {}
        }

        if (path.startsWith(srcDir) && !ssrEntryAbsPaths.has(path)) return;

        // Re-scan and invalidate the virtual module in ALL environments.
        // The route table virtual module lives in the workerd environment,
        // not the client — so we must iterate all environments.
        await rescan();
        writeRouteTypes();
        writeQueueTypes();
        writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry(scan!.queues.length > 0));

        for (const env of Object.values(devServer.environments)) {
          const mod = env.moduleGraph.getModuleById(VIRTUAL_ROUTES_ID);
          if (mod) {
            env.moduleGraph.invalidateModule(mod);
            env.hot.send({ type: "full-reload" });
          }
        }
      };

      watcher.on("add", handleFileChange);
      watcher.on("change", handleFileChange);
      watcher.on("unlink", handleFileChange);
    },
  };
}
