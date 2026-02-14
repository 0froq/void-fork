import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { scanRoutes, type ScanResult } from "./router/scan";
import {
  compileRouteTable,
  compileWorkerEntry,
  type CompileOptions,
} from "./router/compile";
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
  // 1. "vite-plugin-cloud" bare import would pull in the entire plugin
  // 2. "rou3" is a dep of vite-plugin-cloud, not the user's project
  // 3. Virtual modules have no filesystem location for relative resolution
  const resolveFile = (specifier: string) =>
    fileURLToPath(import.meta.resolve(specifier));

  const handlerFile = resolveFile("vite-plugin-cloud/handler");
  const compileOptions: CompileOptions = {
    rou3Path: resolveFile("rou3"),
    contextPath: resolveFile("vite-plugin-cloud/context"),
    responsePath: resolveFile("vite-plugin-cloud/response"),
  };

  function generateEntryFile() {
    const outDir = join(root, ".vite-cloud");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry(compileOptions));
  }

  return {
    name: "vite-cloud:routing",
    enforce: "pre",

    async buildStart() {
      await rescan();
      generateEntryFile();
    },

    resolveId(id) {
      if (id === VIRTUAL_ROUTES_ID) {
        return RESOLVED_VIRTUAL_ROUTES_ID;
      }
      // Redirect bare "vite-plugin-cloud" imports to the lightweight handler
      // subpath to avoid pulling the entire plugin into the Worker bundle.
      if (id === "vite-plugin-cloud") {
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

        // Re-scan and invalidate the virtual module so Vite re-loads it
        await rescan();

        const mod = devServer.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ROUTES_ID);
        if (mod) {
          devServer.moduleGraph.invalidateModule(mod);
          devServer.ws.send({ type: "full-reload" });
        }
      };

      watcher.on("add", handleFileChange);
      watcher.on("unlink", handleFileChange);
    },
  };
}
