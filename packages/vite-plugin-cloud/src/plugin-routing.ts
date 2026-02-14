import { join } from "node:path";
import type { Plugin } from "vite";
import { scanRoutes, type ScanResult } from "./router/scan";
import { compileRouteTable, compileWorkerEntry } from "./router/compile";
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

  function generateEntryFile() {
    const outDir = join(root, ".vite-cloud");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "entry.ts"), compileWorkerEntry());
  }

  return {
    name: "vite-cloud:routing",

    async buildStart() {
      await rescan();
      generateEntryFile();
    },

    resolveId(id) {
      if (id === VIRTUAL_ROUTES_ID) {
        return RESOLVED_VIRTUAL_ROUTES_ID;
      }
    },

    async load(id) {
      if (id === RESOLVED_VIRTUAL_ROUTES_ID) {
        if (!scan) await rescan();
        return compileRouteTable(scan!, routesDir, middlewareDir);
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
