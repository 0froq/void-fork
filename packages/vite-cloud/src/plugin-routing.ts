import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import { scanRoutes, type ScanResult } from "./router/scan";
import {
  compileRouteTable,
  compileWorkerEntry,
  type CompileOptions,
  type SsrCompileOptions,
} from "./router/compile";
import type { AuthProvider } from "./index";
import {
  getPrerenderConfig,
  validatePrerenderPath,
  validateSsrEntries,
  SSR_SERVER_ENTRY_RELATIVE_PATHS,
  SSR_CLIENT_ENTRY_RELATIVE_PATHS,
} from "./ssr/entry";

const VIRTUAL_ROUTES_ID = "virtual:vite-cloud-routes";
// Rolldown resolveId hook filters currently require RegExp for `id`.
const RESOLVE_ID_FILTER = /^(virtual:vite-cloud-routes|vite-cloud)$/;
const LOAD_ID_FILTER = /^virtual:vite-cloud-routes$/;

/**
 * Vite plugin that provides file-based routing.
 * - Scans routes/ and middleware/ directories
 * - Generates virtual modules for the route table and worker entry
 * - Watches for file changes and triggers HMR
 */
interface RoutingPluginOptions {
  auth: AuthProvider[] | null;
}

export function routingPlugin(root: string, options: RoutingPluginOptions): Plugin {
  let scan: ScanResult | null = null;
  let ssr: SsrCompileOptions | null = null;
  let prerenderPaths: string[] = [];
  let hasPrerenderFn = false;
  let resolvedConfig: ResolvedConfig | null = null;
  const routesDir = join(root, "routes");
  const middlewareDir = join(root, "middleware");
  const jobsDir = join(root, "jobs");
  const srcDir = join(root, "src");
  const ssrEntryAbsPaths = new Set(
    [...SSR_SERVER_ENTRY_RELATIVE_PATHS, ...SSR_CLIENT_ENTRY_RELATIVE_PATHS].map((path) =>
      join(root, path),
    ),
  );

  async function rescan() {
    scan = await scanRoutes(root);
    const entries = validateSsrEntries(root);
    ssr = entries
      ? {
          serverEntryPath: entries.server.absolutePath,
          clientEntryRelativePath: entries.client.relativePath,
        }
      : null;
    const prerenderConfig = entries ? getPrerenderConfig(root) : { type: "none" as const };
    prerenderPaths = prerenderConfig.type === "static" ? prerenderConfig.paths : [];
    hasPrerenderFn = prerenderConfig.type === "function";
  }

  // Pre-resolve all runtime module paths so generated code uses absolute paths.
  // This is necessary because:
  // 1. "vite-cloud" bare import would pull in the entire plugin
  // 2. "hono" is a dep of vite-cloud, not the user's project
  // 3. Virtual modules have no filesystem location for relative resolution
  const resolveFile = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

  const handlerFile = resolveFile("vite-cloud/handler");
  const compileOptions: CompileOptions = {
    honoPath: resolveFile("hono"),
    responsePath: resolveFile("vite-cloud/response"),
    reactRefresh: false,
    auth: null,
  };

  if (options.auth) {
    const providers = options.auth;
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

  // Generate the entry file eagerly (at plugin creation time, during viteCloud()).
  // The CF plugin needs the `main` file to exist at config resolution time,
  // which is before any hooks like buildStart fire.
  const outDir = join(root, ".vite-cloud");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry());

  return {
    name: "vite-cloud:routing",
    enforce: "pre",
    configResolved(config) {
      resolvedConfig = config;
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
      await rescan();
    },

    resolveId: {
      filter: { id: RESOLVE_ID_FILTER },
      handler(id) {
        if (id === VIRTUAL_ROUTES_ID) {
          return VIRTUAL_ROUTES_ID;
        }
        // Redirect bare "vite-cloud" imports to the lightweight handler
        // subpath to avoid pulling the entire plugin into the Worker bundle.
        if (id === "vite-cloud") {
          return handlerFile;
        }
      },
    },

    load: {
      filter: { id: LOAD_ID_FILTER },
      async handler(id) {
        if (id !== VIRTUAL_ROUTES_ID) return;
        if (!scan) await rescan();
        return compileRouteTable(scan!, routesDir, middlewareDir, jobsDir, ssr, compileOptions);
      },
    },

    configureServer(devServer) {
      // Watch routes/ and middleware/ for new/removed files
      const watcher = devServer.watcher;

      const handleFileChange = async (path: string) => {
        if (
          !path.startsWith(routesDir) &&
          !path.startsWith(middlewareDir) &&
          !path.startsWith(jobsDir) &&
          !path.startsWith(srcDir)
        ) {
          return;
        }

        if (path.startsWith(srcDir) && !ssrEntryAbsPaths.has(path)) return;

        // Re-scan and invalidate the virtual module in ALL environments.
        // The route table virtual module lives in the workerd environment,
        // not the client — so we must iterate all environments.
        await rescan();

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

    async closeBundle() {
      if (!resolvedConfig || resolvedConfig.command !== "build" || resolvedConfig.build.watch)
        return;
      if (!ssr) return;
      if (prerenderPaths.length === 0 && !hasPrerenderFn) return;

      const outDir = isAbsolute(resolvedConfig.build.outDir)
        ? resolvedConfig.build.outDir
        : join(resolvedConfig.root, resolvedConfig.build.outDir);

      // In multi-environment builds, run SSG only during the client build.
      // At this point both worker output and client manifest are available.
      if (basename(outDir) !== "client") return;

      const parentDir = dirname(outDir);
      const nestedClientOutDir =
        existsSync(join(parentDir, "index.js")) && existsSync(join(parentDir, "wrangler.json"));
      const clientDir = nestedClientOutDir ? join(dirname(parentDir), "client") : outDir;
      const distDir = dirname(clientDir);
      const workerEntry = resolveWorkerEntry(root, distDir);
      mkdirSync(clientDir, { recursive: true });
      if (!existsSync(workerEntry)) {
        throw new Error(`SSG failed: worker entry not found at ${workerEntry}.`);
      }

      const moduleUrl = pathToFileURL(workerEntry).href;
      const mod = (await dynamicImport(moduleUrl)) as {
        default?: { fetch?: (...args: any[]) => unknown };
        __resolvePrerenderPaths?: () => Promise<string[] | null>;
      };
      const worker = mod.default;
      if (!worker || typeof worker.fetch !== "function") {
        throw new Error(`Invalid worker entry at ${workerEntry}: expected default fetch handler.`);
      }

      let pathsToRender = prerenderPaths;
      if (hasPrerenderFn) {
        if (typeof mod.__resolvePrerenderPaths !== "function") {
          throw new Error(`SSG failed: worker entry does not export __resolvePrerenderPaths.`);
        }
        const resolved = await mod.__resolvePrerenderPaths();
        if (!Array.isArray(resolved)) {
          throw new Error(`Prerender function must return an array of paths.`);
        }
        pathsToRender = resolved.map(validatePrerenderPath);
      }

      if (pathsToRender.length === 0) return;

      const env = createPrerenderEnv(clientDir);
      for (const path of pathsToRender) {
        const request = new Request(`http://vite-cloud.local${path}`, {
          headers: { Accept: "text/html" },
        });
        const response = await worker.fetch(request, env, createExecutionContext());

        if (!(response instanceof Response)) {
          throw new Error(`Prerender failed for "${path}": render did not return a Response.`);
        }
        if (!response.ok) {
          throw new Error(`Prerender failed for "${path}": received HTTP ${response.status}.`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html")) {
          throw new Error(
            `Prerender failed for "${path}": expected text/html response, received "${contentType || "unknown"}".`,
          );
        }

        const html = await response.text();
        const outPath =
          path === "/"
            ? join(clientDir, "index.html")
            : join(clientDir, path.slice(1), "index.html");
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, html);
      }
    },
  };
}

function resolveWorkerEntry(root: string, distDir: string): string {
  const directEntry = join(distDir, "index.js");
  if (existsSync(directEntry) && existsSync(join(distDir, "wrangler.json"))) {
    return directEntry;
  }
  const workerDirName = detectWorkerDir(root, distDir);
  return join(distDir, workerDirName, "index.js");
}

function detectWorkerDir(root: string, distDir: string): string {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const packageName: string = pkg.name ?? "worker";
  const workerName = packageName.replace(/^@[^/]+\//, "");
  const expected = workerName.replaceAll("-", "_");
  const expectedPath = join(distDir, expected);

  if (existsSync(expectedPath)) return expected;
  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "client" && !name.startsWith("."));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(`No worker output directory found in ${distDir}. Expected ${expectedPath}.`);
  }
  throw new Error(
    `Could not determine worker output directory in ${distDir}. Expected ${expectedPath}. Found multiple candidates: ${candidates.join(
      ", ",
    )}`,
  );
}

function createExecutionContext(): ExecutionContext {
  return {
    props: {},
    waitUntil() {},
    passThroughOnException() {},
  };
}

function createPrerenderEnv(clientDir: string): Record<string, unknown> {
  const kv = new Map<string, string>();

  return {
    KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
      async list() {
        return { keys: Array.from(kv.keys()).map((name) => ({ name })) };
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        const relative = url.pathname.replace(/^\/+/, "");
        const filePath = join(clientDir, relative);
        if (!existsSync(filePath)) {
          return new Response("Not Found", { status: 404 });
        }
        const content = readFileSync(filePath);
        const contentType = relative.endsWith(".json")
          ? "application/json"
          : relative.endsWith(".html")
            ? "text/html; charset=utf-8"
            : "application/octet-stream";
        return new Response(content, {
          status: 200,
          headers: { "content-type": contentType },
        });
      },
    },
  };
}

// Keep the import specifier fully runtime-dynamic so bundlers do not rewrite it.
const dynamicImport = (0, eval)("specifier => import(specifier)") as (
  specifier: string,
) => Promise<unknown>;
