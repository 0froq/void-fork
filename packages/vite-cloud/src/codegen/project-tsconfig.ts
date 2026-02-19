import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure .vite-cloud/tsconfig.json exists so the user's root tsconfig can
 * extend it. Lists the generated declaration files so TypeScript discovers
 * them via the `files` field (which is inherited by `extends`, unlike `include`).
 *
 * @param hasRouteTypes - When true, include routes.d.ts. When omitted,
 *   auto-detect by checking for a routes/ directory.
 */
export function ensureProjectTsconfig(root: string, hasRouteTypes?: boolean): void {
  const outDir = join(root, ".vite-cloud");
  mkdirSync(outDir, { recursive: true });
  const includeRoutes = hasRouteTypes ?? existsSync(join(root, "routes"));
  const includeQueues = existsSync(join(root, "queues"));
  const files = [
    ...(includeRoutes ? ["routes.d.ts"] : []),
    "db.d.ts",
    ...(includeQueues ? ["queues.d.ts"] : []),
  ];
  writeFileSync(join(outDir, "tsconfig.json"), JSON.stringify({ files }, null, 2) + "\n");
}
