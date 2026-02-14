import type { ScanResult } from "./scan";

export interface CompileOptions {
  /** Absolute path to the hono module entry */
  honoPath: string;
  /** Absolute path to the vite-cloud/response module */
  responsePath: string;
}

/**
 * Generate the code for the virtual route table module (virtual:vite-cloud-routes).
 * This module creates a Hono app with:
 * - Middleware registered via app.use()
 * - Routes registered with lazy-loaded handlers and auto-conversion
 */
export function compileRouteTable(
  scan: ScanResult,
  routesDir: string,
  middlewareDir: string,
  options: CompileOptions,
): string {
  const lines: string[] = [];

  lines.push(`import { Hono } from ${JSON.stringify(options.honoPath)};`);
  lines.push(`import { convertReturnValue } from ${JSON.stringify(options.responsePath)};`);
  lines.push("");

  // Generate eager imports for middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    const mw = scan.middleware[i];
    lines.push(`import middleware${i} from ${JSON.stringify(`${middlewareDir}/${mw.filePath}`)};`);
  }
  lines.push("");

  lines.push(`const app = new Hono();`);
  lines.push("");

  // Register middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    lines.push(`app.use(middleware${i});`);
  }
  if (scan.middleware.length > 0) {
    lines.push("");
  }

  // Register routes with lazy-loaded handlers
  for (const route of scan.routes) {
    const method = route.method === "*" ? "all" : route.method.toLowerCase();
    const filePath = JSON.stringify(`${routesDir}/${route.filePath}`);
    lines.push(`app.${method}(${JSON.stringify(route.pattern)}, async (c) => {`);
    lines.push(`  const mod = await import(${filePath});`);
    lines.push(`  return convertReturnValue(await mod.default(c));`);
    lines.push(`});`);
  }
  lines.push("");

  lines.push(`export default app;`);

  return lines.join("\n");
}

/**
 * Generate the Worker entry module code.
 * Simply re-exports the Hono app from the virtual module.
 */
export function compileWorkerEntry(): string {
  return `import app from 'virtual:vite-cloud-routes';

export default app;`;
}
