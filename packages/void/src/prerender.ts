import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { loadEnv } from "vite";
import { voidLog, voidWarn } from "./log";

interface PrerenderResult {
  rendered: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Prerender pages by spinning up Miniflare with the built worker and
 * fetching each path. Writes HTML responses to `clientDir`.
 */
export async function prerenderPages(options: {
  root: string;
  workerDir: string; // absolute path to dist/<workerDir>
  clientDir: string; // absolute path to dist/client
  paths: string[];
  persistDir: string; // .void
}): Promise<PrerenderResult> {
  const { root, workerDir, clientDir, paths, persistDir } = options;

  if (paths.length === 0) return { rendered: [], failed: [] };

  // Read the wrangler.json emitted by @cloudflare/vite-plugin during build
  const wranglerPath = join(workerDir, "wrangler.json");
  if (!existsSync(wranglerPath)) {
    throw new Error(`[void] wrangler.json not found in ${workerDir}`);
  }
  const wranglerConfig = JSON.parse(readFileSync(wranglerPath, "utf-8"));
  const workerEntry = join(workerDir, wranglerConfig.main ?? "index.js");

  // Load .env vars (same as dev — production .env without .local files)
  const env = loadEnv("production", root, "");

  // Dynamic import — miniflare is a transitive dependency via wrangler.
  // Resolve from wrangler's context since pnpm doesn't hoist it.
  const wranglerUrl = import.meta.resolve("wrangler/package.json");
  const require = createRequire(wranglerUrl);
  const miniflarePath = require.resolve("miniflare");
  const { Miniflare } = (await import(miniflarePath)) as {
    Miniflare: new (options: Record<string, unknown>) => {
      dispatchFetch(url: string): Promise<Response>;
      dispose(): Promise<void>;
    };
  };

  // Build Miniflare options from the wrangler config.
  // Use scriptPath (not modules array) so Miniflare resolves relative chunk
  // imports from the worker directory. modulesRoot sets the base path.
  // modulesRules tells Miniflare to treat .js files as ESModule (matching
  // the rules in wrangler.json emitted by the CF vite plugin).
  const mfOptions: Record<string, unknown> = {
    scriptPath: workerEntry,
    modules: true,
    modulesRoot: workerDir,
    modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
    compatibilityDate: wranglerConfig.compatibility_date ?? "2024-01-01",
    compatibilityFlags: wranglerConfig.compatibility_flags ?? [],
    // Merge wrangler vars with .env vars
    bindings: { ...wranglerConfig.vars, ...env },
    // Provide ASSETS binding so the worker can load the client manifest
    // and generate production asset tags instead of dev-time URLs.
    serviceBindings: {
      ASSETS(request: Request) {
        const url = new URL(request.url);
        const filePath = join(clientDir, url.pathname);
        try {
          const content = readFileSync(filePath);
          return new Response(content);
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      },
    },
  };

  // D1
  const d1 = wranglerConfig.d1_databases;
  if (Array.isArray(d1) && d1.length > 0) {
    const databases: Record<string, string> = {};
    for (const db of d1) {
      databases[db.binding] = db.database_id;
    }
    mfOptions.d1Databases = databases;
    mfOptions.d1Persist = persistDir;
  }

  // KV
  const kv = wranglerConfig.kv_namespaces;
  if (Array.isArray(kv) && kv.length > 0) {
    const namespaces: Record<string, string> = {};
    for (const ns of kv) {
      namespaces[ns.binding] = ns.id;
    }
    mfOptions.kvNamespaces = namespaces;
    mfOptions.kvPersist = persistDir;
  }

  // R2
  const r2 = wranglerConfig.r2_buckets;
  if (Array.isArray(r2) && r2.length > 0) {
    const buckets: Record<string, string> = {};
    for (const bucket of r2) {
      buckets[bucket.binding] = bucket.bucket_name;
    }
    mfOptions.r2Buckets = buckets;
    mfOptions.r2Persist = persistDir;
  }

  const mf = new Miniflare(mfOptions);
  const result: PrerenderResult = { rendered: [], failed: [] };

  try {
    for (const path of paths) {
      try {
        const response = await mf.dispatchFetch(`http://localhost${path}`);
        const html = await response.text();

        if (!response.ok) {
          result.failed.push({ path, error: `HTTP ${response.status}` });
          voidWarn(`prerender ${path} failed: HTTP ${response.status}`);
          continue;
        }

        // /about → dist/client/about.html, / → dist/client/index.html
        const outputFile = path === "/" ? "index.html" : `${path.slice(1)}.html`;
        const outputPath = join(clientDir, outputFile);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, html);
        result.rendered.push(path);
        voidLog(`prerender \x1b[36m${outputFile}\x1b[39m`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.failed.push({ path, error });
        voidWarn(`prerender ${path} failed: ${error}`);
      }
    }
  } finally {
    await mf.dispose();
  }

  return result;
}
