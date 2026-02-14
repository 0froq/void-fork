import { glob } from "tinyglobby";
import { parseRouteFilename, type RouteDefinition } from "./parse-filename";

export interface ScanResult {
  routes: RouteDefinition[];
  middleware: MiddlewareDefinition[];
}

export interface MiddlewareDefinition {
  /** Numeric order prefix (e.g. 1 for "01.logger.ts") */
  order: number;
  /** Original filename */
  filePath: string;
}

const HANDLER_EXTENSIONS = ["ts", "mts", "js", "mjs"];

/**
 * Scan routes/ and middleware/ directories and return a structured manifest.
 * Files starting with _ are ignored.
 */
export async function scanRoutes(root: string): Promise<ScanResult> {
  const pattern = `**/*.{${HANDLER_EXTENSIONS.join(",")}}`;

  const [routeFiles, middlewareFiles] = await Promise.all([
    glob(pattern, { cwd: `${root}/routes`, absolute: false }),
    glob(pattern, { cwd: `${root}/middleware`, absolute: false }).catch(() => [] as string[]),
  ]);

  // Parse routes, filtering out files starting with _
  const routes = routeFiles
    .filter((f) => !f.split("/").some((s) => s.startsWith("_")))
    .map((f) => parseRouteFilename(f))
    // Sort: static routes before dynamic, catch-all last
    .sort((a, b) => {
      if (a.catchAll !== b.catchAll) return a.catchAll ? 1 : -1;
      return a.pattern.localeCompare(b.pattern);
    });

  // Parse middleware, sorted by numeric prefix
  const middleware = middlewareFiles
    .filter((f) => !f.startsWith("_"))
    .map((f) => {
      const basename = f.split("/").pop()!;
      const match = basename.match(/^(\d+)\./);
      return {
        order: match ? parseInt(match[1], 10) : Infinity,
        filePath: f,
      };
    })
    .sort((a, b) => a.order - b.order);

  return { routes, middleware };
}
