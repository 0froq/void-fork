import type { ScanResult } from "./scan";

/**
 * Generate the code for the virtual route table module (virtual:vite-cloud-routes).
 * This module:
 * - Imports rou3 for runtime routing
 * - Registers all discovered routes
 * - Exports the router, routes metadata, and middleware list
 */
export function compileRouteTable(
  scan: ScanResult,
  routesDir: string,
  middlewareDir: string,
): string {
  const lines: string[] = [];

  lines.push(`import { createRouter, addRoute, findRoute } from 'rou3';`);
  lines.push("");

  // Generate lazy imports for each route handler
  for (let i = 0; i < scan.routes.length; i++) {
    const route = scan.routes[i];
    lines.push(
      `const route${i} = () => import(${JSON.stringify(`${routesDir}/${route.filePath}`)});`,
    );
  }
  lines.push("");

  // Generate imports for middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    const mw = scan.middleware[i];
    lines.push(`import middleware${i} from ${JSON.stringify(`${middlewareDir}/${mw.filePath}`)};`);
  }
  lines.push("");

  // Create and populate the router
  lines.push(`const router = createRouter();`);
  lines.push("");

  for (let i = 0; i < scan.routes.length; i++) {
    const route = scan.routes[i];
    // rou3 uses empty string for "all methods"
    const method = route.method === "*" ? "" : route.method.toUpperCase();
    lines.push(
      `addRoute(router, ${JSON.stringify(method)}, ${JSON.stringify(route.pattern)}, { load: route${i}, method: ${JSON.stringify(route.method)} });`,
    );
  }
  lines.push("");

  // Export route metadata
  lines.push(`export const routes = ${JSON.stringify(scan.routes, null, 2)};`);
  lines.push("");

  // Export middleware array
  lines.push(
    `export const middleware = [${scan.middleware.map((_, i) => `middleware${i}`).join(", ")}];`,
  );
  lines.push("");

  // Export router lookup function
  lines.push(`export function matchRoute(method, path) {`);
  lines.push(`  return findRoute(router, method, path);`);
  lines.push(`}`);

  return lines.join("\n");
}

/**
 * Generate the Worker entry module code.
 * This is the `fetch` handler that:
 * 1. Builds the RequestContext
 * 2. Runs middleware in order
 * 3. Matches the route
 * 4. Lazy-loads and executes the handler
 * 5. Converts the return value to a Response
 */
export function compileWorkerEntry(): string {
  return `
import { matchRoute, middleware } from 'virtual:vite-cloud-routes';
import { createRequestContext } from 'vite-plugin-cloud/context';
import { convertReturnValue } from 'vite-plugin-cloud/response';

export default {
  async fetch(request, rawEnv, executionContext) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Match route
    const matched = matchRoute(method, path);

    if (!matched) {
      return new Response('Not Found', { status: 404 });
    }

    // Build context
    const params = matched.params || {};
    const ctx = createRequestContext(request, rawEnv, params);

    // Run middleware in order
    for (const mw of middleware) {
      const result = await mw(ctx);
      if (result !== undefined && result !== null) {
        return convertReturnValue(result);
      }
    }

    // Lazy-load and execute the matched handler
    const mod = await matched.data.load();
    const handler = mod.default;
    const result = await handler(ctx);
    return convertReturnValue(result);
  }
};
`.trim();
}
