import { join } from "node:path";
import type { Plugin } from "vite";
import type { VoidConfig } from "./config";
import { detectWorkerDir } from "./cli/deploy";
import { collectPrerenderPaths } from "./prerender-paths";
import { prerenderPages } from "./prerender";
import { voidLog, voidWarn, setShowTimestamp } from "./log";

/**
 * Vite plugin that prerenders pages at build time when `output: "static"`.
 *
 * Runs in the `closeBundle` hook so prerender logs appear after Vite's
 * asset summary. Gated on the "client" environment so it only runs once.
 */
export function prerenderPlugin(root: string, config: VoidConfig): Plugin {
  return {
    name: "void:prerender",
    apply: "build",

    async closeBundle() {
      if (config.output !== "static") return;
      if (this.environment?.name !== "client") return;
      setShowTimestamp(false);

      const distDir = join(root, "dist");
      const clientDir = join(distDir, "client");
      const persistDir = join(root, ".void");

      // Detect the worker output directory
      let workerDirName: string;
      try {
        workerDirName = detectWorkerDir(root, distDir);
      } catch (err) {
        voidWarn(`Skipping prerender: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const workerDir = join(distDir, workerDirName);

      // Collect paths to prerender
      const paths = await collectPrerenderPaths({ root, config });
      if (paths.length === 0) {
        voidLog("No pages to prerender");
        return;
      }

      voidLog(`Prerendering ${paths.length} page(s)...`);

      // Render
      const result = await prerenderPages({
        root,
        workerDir,
        clientDir,
        paths,
        persistDir,
      });

      if (result.failed.length > 0) {
        voidWarn(`${result.failed.length} page(s) failed to prerender`);
      }
    },
  };
}
