import type { ScanResult } from "./scan";

export interface CompileOptions {
  /** Absolute path to the hono module entry */
  honoPath: string;
  /** Absolute path to the vite-cloud/response module */
  responsePath: string;
  /** Whether to inject React Fast Refresh preamble in dev SSR HTML. */
  reactRefresh: boolean;
}

export interface SsrCompileOptions {
  /** Absolute path to src/main.ssr.ts(x) */
  serverEntryPath: string;
  /** Relative project path for src/main.client.ts(x), e.g. src/main.client.tsx */
  clientEntryRelativePath: string;
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
  jobsDir: string,
  ssr: SsrCompileOptions | null,
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

  if (ssr) {
    const clientEntryUrl = `/${ssr.clientEntryRelativePath}`;
    lines.push(`const SSR_CLIENT_ENTRY_ID = ${JSON.stringify(ssr.clientEntryRelativePath)};`);
    lines.push(`const SSR_CLIENT_ENTRY_URL = ${JSON.stringify(clientEntryUrl)};`);
    lines.push(`let cachedSsrManifest = null;`);
    lines.push("");
    lines.push(`function escapeHtml(value) {`);
    lines.push(`  return String(value).replace(/"/g, "&quot;");`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function getDevClientTags() {`);
    lines.push(`  const headTags = [\`<script type="module" src="/@vite/client"></script>\`];`);
    if (options.reactRefresh) {
      lines.push(`  headTags.push(\`<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>\`);`);
    }
    lines.push(
      `  const bodyTag = \`<script type="module" src="\${escapeHtml(SSR_CLIENT_ENTRY_URL)}"></script>\`;`,
    );
    lines.push(`  return { head: headTags.join("\\n"), body: bodyTag };`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function collectManifestFiles(manifest, entryId) {`);
    lines.push(`  const seen = new Set();`);
    lines.push(`  const toVisit = [entryId];`);
    lines.push(`  while (toVisit.length > 0) {`);
    lines.push(`    const currentId = toVisit.pop();`);
    lines.push(`    if (seen.has(currentId)) continue;`);
    lines.push(`    seen.add(currentId);`);
    lines.push(`    const chunk = manifest[currentId];`);
    lines.push(`    if (!chunk || !Array.isArray(chunk.imports)) continue;`);
    lines.push(`    for (const importedId of chunk.imports) toVisit.push(importedId);`);
    lines.push(`  }`);
    lines.push(`  return Array.from(seen);`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function loadSsrManifest(request, env) {`);
    lines.push(`  if (cachedSsrManifest) return cachedSsrManifest;`);
    lines.push(`  const assets = env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") return null;`);
    lines.push(`  const manifestUrl = new URL("/.vite/manifest.json", request.url);`);
    lines.push(`  const response = await assets.fetch(new Request(manifestUrl.toString()));`);
    lines.push(`  if (!response.ok) return null;`);
    lines.push(`  cachedSsrManifest = await response.json();`);
    lines.push(`  return cachedSsrManifest;`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function getClientAssetTags(request, env) {`);
    lines.push(`  const manifest = await loadSsrManifest(request, env);`);
    lines.push(`  if (!manifest || typeof manifest !== "object") {`);
    lines.push(`    return getDevClientTags();`);
    lines.push(`  }`);
    lines.push(`  const entry = manifest[SSR_CLIENT_ENTRY_ID];`);
    lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
    lines.push(`    return { head: "", body: "" };`);
    lines.push(`  }`);
    lines.push(`  const ids = collectManifestFiles(manifest, SSR_CLIENT_ENTRY_ID);`);
    lines.push(`  const cssFiles = new Set();`);
    lines.push(`  const preloadFiles = new Set();`);
    lines.push(`  for (const id of ids) {`);
    lines.push(`    const chunk = manifest[id];`);
    lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
    lines.push(`    if (Array.isArray(chunk.css)) {`);
    lines.push(`      for (const cssFile of chunk.css) cssFiles.add(cssFile);`);
    lines.push(`    }`);
    lines.push(`    if (id !== SSR_CLIENT_ENTRY_ID && typeof chunk.file === "string") {`);
    lines.push(`      preloadFiles.add(chunk.file);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  const headTags = [];`);
    lines.push(`  for (const cssFile of cssFiles) {`);
    lines.push(`    headTags.push(\`<link rel="stylesheet" href="/\${escapeHtml(cssFile)}">\`);`);
    lines.push(`  }`);
    lines.push(`  for (const preloadFile of preloadFiles) {`);
    lines.push(
      `    headTags.push(\`<link rel="modulepreload" href="/\${escapeHtml(preloadFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(
      `  const bodyTag = \`<script type="module" src="/\${escapeHtml(entry.file)}"></script>\`;`,
    );
    lines.push(`  return { head: headTags.join("\\n"), body: bodyTag };`);
    lines.push(`}`);
    lines.push("");
    lines.push(`function shouldHandleSsrRequest(c) {`);
    lines.push(`  const path = c.req.path;`);
    lines.push(`  if (path === "/api" || path.startsWith("/api/")) return false;`);
    lines.push(`  if (/\\/[^/]+\\.[^/]+$/.test(path)) return false;`);
    lines.push(`  const destination = c.req.header("sec-fetch-dest");`);
    lines.push(
      `  if (destination && destination !== "document" && destination !== "empty") return false;`,
    );
    lines.push(`  return true;`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function fetchFromAssets(c) {`);
    lines.push(`  const assets = c.env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") {`);
    lines.push(`    return new Response("Not Found", { status: 404 });`);
    lines.push(`  }`);
    lines.push(`  const response = await assets.fetch(c.req.raw);`);
    lines.push(
      `  return response.status === 404 ? new Response("Not Found", { status: 404 }) : response;`,
    );
    lines.push(`}`);
    lines.push("");
    lines.push(`async function fetchPrerenderedHtml(c) {`);
    lines.push(`  const assets = c.env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") {`);
    lines.push(`    return null;`);
    lines.push(`  }`);
    lines.push(`  const normalizedPath = c.req.path.replace(/\\/+$/, "") || "/";`);
    lines.push(
      `  const prerenderPath = normalizedPath === "/" ? "/index.html" : \`\${normalizedPath}/index.html\`;`,
    );
    lines.push(`  const url = new URL(prerenderPath, c.req.url);`);
    lines.push(`  const response = await assets.fetch(new Request(url.toString()));`);
    lines.push(`  if (!response.ok) {`);
    lines.push(`    return null;`);
    lines.push(`  }`);
    lines.push(`  const contentType = response.headers.get("content-type") ?? "";`);
    lines.push(`  if (!contentType.includes("text/html")) {`);
    lines.push(`    return null;`);
    lines.push(`  }`);
    lines.push(`  return response;`);
    lines.push(`}`);
    lines.push("");
    lines.push(`async function renderSsrResponse(c, mod) {`);
    lines.push(`  const render = typeof mod.render === "function" ? mod.render : mod.default;`);
    lines.push(`  if (typeof render !== "function") {`);
    lines.push(
      `    throw new Error("Invalid SSR entry: expected exported render(c, assetTags) function.");`,
    );
    lines.push(`  }`);
    lines.push(`  const assetTags = await getClientAssetTags(c.req.raw, c.env);`);
    lines.push(`  return render(c, assetTags);`);
    lines.push(`}`);
    lines.push("");
    lines.push(`app.notFound(async (c) => {`);
    lines.push(`  if (!shouldHandleSsrRequest(c)) {`);
    lines.push(`    return fetchFromAssets(c);`);
    lines.push(`  }`);
    lines.push(`  const prerendered = await fetchPrerenderedHtml(c);`);
    lines.push(`  if (prerendered) {`);
    lines.push(`    return prerendered;`);
    lines.push(`  }`);
    lines.push(`  const mod = await import(${JSON.stringify(ssr.serverEntryPath)});`);
    lines.push(`  return renderSsrResponse(c, mod);`);
    lines.push(`});`);
    lines.push("");
  }

  if (scan.jobs.length > 0) {
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      lines.push(`const job${i}Cron = ${JSON.stringify(job.cron)};`);
    }
    lines.push("");
    lines.push("export async function scheduled(controller, env, ctx) {");
    lines.push("  switch (controller.cron) {");
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      const filePath = JSON.stringify(`${jobsDir}/${job.filePath}`);
      lines.push(`    case job${i}Cron: {`);
      lines.push(`      const mod = await import(${filePath});`);
      lines.push("      if (typeof mod.default === 'function') {");
      lines.push("        await mod.default(controller, env, ctx);");
      lines.push("      }");
      lines.push("      return;");
      lines.push("    }");
    }
    lines.push("    default:");
    lines.push("      return;");
    lines.push("  }");
    lines.push("}");
    lines.push("");
  } else {
    lines.push("export async function scheduled() {}");
    lines.push("");
  }

  lines.push(`export default app;`);

  return lines.join("\n");
}

/**
 * Generate the Worker entry module code.
 * Simply re-exports the Hono app from the virtual module.
 */
export function compileWorkerEntry(): string {
  return `import app, { scheduled } from 'virtual:vite-cloud-routes';

export default { fetch: app.fetch, scheduled };`;
}
