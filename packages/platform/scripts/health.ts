/**
 * Platform API health check script.
 *
 * Routes are discovered by scanning src/routes/*.ts and src/index.ts,
 * so this script never drifts from the actual API surface.
 *
 * Usage:
 *   node scripts/health.ts            # production
 *   node scripts/health.ts --staging  # staging
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────

const isStaging = process.argv.includes("--staging");

interface Config {
  token?: string;
  stagingToken?: string;
  api?: string;
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".vite-cloud", "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

const config = readConfig();
const token = isStaging ? config.stagingToken : config.token;
const baseUrl = isStaging ? "https://platform.staging.vite.cloud" : "https://platform.vite.cloud";

if (!token) {
  console.error(`No ${isStaging ? "stagingToken" : "token"} found in ~/.vite-cloud/config.json`);
  console.error("Run `vcc login` first.");
  process.exit(1);
}

// ── Route discovery ─────────────────────────────────────────────────

interface Route {
  method: string;
  path: string;
}

const platformSrc = resolve(import.meta.dirname, "..", "src");

/**
 * Parse index.ts to find:
 *  - app.route("/base", importedName) → mount map
 *  - app.get/post/...("/path", ...) → inline routes
 *  - import importedName from "./routes/file" → file map
 */
function parseIndex(): { mounts: Map<string, string[]>; inlineRoutes: Route[] } {
  const src = readFileSync(join(platformSrc, "index.ts"), "utf-8");

  // Build import-name → file map: `import foo from "./routes/bar"`
  const importMap = new Map<string, string>();
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+["']\.\/routes\/([^"']+)["']/g)) {
    importMap.set(m[1], m[2]);
  }

  // Mounts: `app.route("/projects", projects)`
  // A file can be mounted at multiple bases (e.g. usage at /projects + /usage)
  const mounts = new Map<string, string[]>();
  for (const m of src.matchAll(/app\.route\(["']([^"']+)["'],\s*(\w+)\)/g)) {
    const base = m[1];
    const name = m[2];
    const file = importMap.get(name);
    if (file) {
      const existing = mounts.get(file) ?? [];
      existing.push(base);
      mounts.set(file, existing);
    }
  }

  // Inline routes: `app.get("/health", ...)`
  const inlineRoutes: Route[] = [];
  for (const m of src.matchAll(/app\.(get|post|put|delete|patch)\(["']([^"']+)["']/g)) {
    inlineRoutes.push({ method: m[1].toUpperCase(), path: m[2] });
  }

  return { mounts, inlineRoutes };
}

/**
 * Scan a route file for `app.get("/path", ...)` etc.
 */
function parseRouteFile(filePath: string): { method: string; subPath: string }[] {
  const src = readFileSync(filePath, "utf-8");
  const routes: { method: string; subPath: string }[] = [];
  for (const m of src.matchAll(/app\.(get|post|put|delete|patch)\(["']([^"']+)["']/g)) {
    routes.push({ method: m[1].toUpperCase(), subPath: m[2] });
  }
  return routes;
}

function discoverRoutes(): Route[] {
  const { mounts, inlineRoutes } = parseIndex();
  const routes: Route[] = [...inlineRoutes];

  const routesDir = join(platformSrc, "routes");
  for (const entry of readdirSync(routesDir)) {
    if (!entry.endsWith(".ts")) continue;
    const fileKey = entry.replace(/\.ts$/, "");

    const bases = mounts.get(fileKey);
    if (!bases) continue;

    const subRoutes = parseRouteFile(join(routesDir, entry));
    for (const base of bases) {
      for (const { method, subPath } of subRoutes) {
        const fullPath = subPath === "/" ? base : base + subPath;
        routes.push({ method, path: fullPath });
      }
    }
  }

  // Deduplicate (a sub-path like GET / can appear from multiple mounts)
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Health checks ───────────────────────────────────────────────────

// ANSI colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface CheckResult {
  method: string;
  path: string;
  status: number | null;
  ms: number;
  skipped?: string;
}

async function probe(method: string, url: string): Promise<{ status: number; ms: number }> {
  const start = performance.now();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  // Drain body
  await res.text();
  return { status: res.status, ms: Math.round(performance.now() - start) };
}

async function run() {
  const routes = discoverRoutes();

  console.log(
    bold(`\nHealth check: ${isStaging ? yellow("STAGING") : "PRODUCTION"} (${baseUrl})\n`),
  );

  // 1. Bootstrap: get a project ID from GET /projects
  let projectId: string | null = null;
  try {
    const res = await fetch(`${baseUrl}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const projects = (await res.json()) as { id: string }[];
      if (projects.length > 0) {
        projectId = projects[0].id;
      }
    }
  } catch {
    // Will be caught in the main loop
  }

  // 2. Probe each route, logging as we go
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const route of routes) {
    // Skip admin routes (different auth mechanism)
    if (route.path.startsWith("/admin")) {
      skipped++;
      continue;
    }

    // Skip auth routes (OAuth flow, not API)
    if (route.path.startsWith("/auth")) {
      skipped++;
      continue;
    }

    // Skip mutating methods — too dangerous to probe
    if (route.method !== "GET") {
      skipped++;
      continue;
    }

    // Resolve :id param
    let resolvedPath = route.path;
    if (resolvedPath.includes(":id")) {
      if (!projectId) {
        skipped++;
        continue;
      }
      resolvedPath = resolvedPath.replace(":id", projectId);
    }

    // Skip routes with remaining unresolved params (e.g. :domainId)
    if (resolvedPath.includes(":")) {
      skipped++;
      continue;
    }

    const label = `GET    ${route.path}`;
    try {
      const { status, ms } = await probe("GET", `${baseUrl}${resolvedPath}`);
      if (status >= 200 && status < 500) {
        console.log(`  ${green("OK")}    ${label}  ${dim(`${status} ${ms}ms`)}`);
        passed++;
      } else {
        console.log(`  ${red("FAIL")}  ${label}  ${red(String(status))} ${dim(`${ms}ms`)}`);
        failed++;
      }
    } catch (err) {
      console.log(
        `  ${red("FAIL")}  ${label}  ${red(err instanceof Error ? err.message : String(err))}`,
      );
      failed++;
    }
  }

  console.log(
    `\n${bold("Summary:")} ${green(`${passed} passed`)}  ${failed ? red(`${failed} failed`) : dim("0 failed")}  ${dim(`(${skipped} routes skipped)`)}\n`,
  );

  if (failed > 0) process.exit(1);
}

run();
