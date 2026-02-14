import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { scanRoutes, type ScanResult } from "./router/scan";
import { compileRouteTable, compileWorkerEntry, type CompileOptions } from "./router/compile";
import { mkdirSync, writeFileSync } from "node:fs";

const VIRTUAL_ROUTES_ID = "virtual:vite-cloud-routes";
const RESOLVED_VIRTUAL_ROUTES_ID = "\0" + VIRTUAL_ROUTES_ID;

/**
 * Vite plugin that provides file-based routing.
 * - Scans routes/ and middleware/ directories
 * - Generates virtual modules for the route table and worker entry
 * - Watches for file changes and triggers HMR
 */
export function routingPlugin(root: string): Plugin {
  let scan: ScanResult | null = null;
  const routesDir = join(root, "routes");
  const middlewareDir = join(root, "middleware");

  async function rescan() {
    scan = await scanRoutes(root);
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
  };

  // Generate the entry file eagerly (at plugin creation time, during viteCloud()).
  // The CF plugin needs the `main` file to exist at config resolution time,
  // which is before any hooks like buildStart fire.
  const outDir = join(root, ".vite-cloud");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry());

  return {
    name: "vite-cloud:routing",
    enforce: "pre",

    async buildStart() {
      await rescan();
    },

    resolveId(id) {
      if (id === VIRTUAL_ROUTES_ID) {
        return RESOLVED_VIRTUAL_ROUTES_ID;
      }
      // Redirect bare "vite-cloud" imports to the lightweight handler
      // subpath to avoid pulling the entire plugin into the Worker bundle.
      if (id === "vite-cloud") {
        return handlerFile;
      }
    },

    async load(id) {
      if (id === RESOLVED_VIRTUAL_ROUTES_ID) {
        if (!scan) await rescan();
        return compileRouteTable(scan!, routesDir, middlewareDir, compileOptions);
      }
    },

    configureServer(devServer) {
      // Watch routes/ and middleware/ for new/removed files
      const watcher = devServer.watcher;

      const handleFileChange = async (path: string) => {
        if (!path.startsWith(routesDir) && !path.startsWith(middlewareDir)) return;

        // Re-scan and invalidate the virtual module in ALL environments.
        // The route table virtual module lives in the workerd environment,
        // not the client — so we must iterate all environments.
        await rescan();

        for (const env of Object.values(devServer.environments)) {
          const mod = env.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ROUTES_ID);
          if (mod) {
            env.moduleGraph.invalidateModule(mod);
            env.hot.send({ type: "full-reload" });
          }
        }
      };

      watcher.on("add", handleFileChange);
      watcher.on("unlink", handleFileChange);
    },
  };
}
