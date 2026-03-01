import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { loadEnv } from "vite";
import { voidLog, voidWarn } from "./log";

export interface PrerenderResult {
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

/**
 * Prerender pages for Node.js targets by spawning a child process.
 *
 * Uses a child process to avoid mutating `process.env` in the parent Vite
 * build process. Writes a temp runner script to `.void/`, spawns it with
 * the loaded env vars, and parses the JSON result from stdout.
 */
export async function prerenderPagesNode(options: {
  root: string;
  ssrDir: string; // absolute path to dist/ssr
  clientDir: string; // absolute path to dist/client
  paths: string[];
}): Promise<PrerenderResult> {
  const { root, ssrDir, clientDir, paths } = options;

  if (paths.length === 0) return { rendered: [], failed: [] };

  // Load .env vars (pure function — does not touch process.env)
  const env = loadEnv("production", root, "");

  // Write a temp runner script that imports the built app and fetches each path
  const runnerPath = join(root, ".void", "prerender-runner.mjs");
  mkdirSync(dirname(runnerPath), { recursive: true });
  writeFileSync(
    runnerPath,
    `
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
const { ssrDir, clientDir, paths } = config;

// Inject the Vite manifest so the SSR renderer can generate production
// asset tags (script/link). loadPagesManifest() checks this global first.
try {
  const manifestPath = join(clientDir, ".vite", "manifest.json");
  globalThis.__VITE_MANIFEST__ = JSON.parse(readFileSync(manifestPath, "utf-8"));
} catch {}

const appUrl = pathToFileURL(join(ssrDir, "app.js")).href;
const app = await import(appUrl);
const fetch = app.default?.fetch;
if (!fetch) {
  console.error("[void] No default export with fetch() found in app.js");
  process.exit(1);
}

const result = { rendered: [], failed: [] };

for (const path of paths) {
  try {
    const response = await fetch(new Request("http://localhost" + path));
    const html = await response.text();
    if (!response.ok) {
      result.failed.push({ path, error: "HTTP " + response.status });
      continue;
    }
    const outputFile = path === "/" ? "index.html" : path.slice(1) + ".html";
    const outputPath = join(clientDir, outputFile);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html);
    result.rendered.push(path);
  } catch (err) {
    result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
  }
}

process.stdout.write(JSON.stringify(result));
`,
  );

  const configJson = JSON.stringify({ ssrDir, clientDir, paths });

  try {
    const result = await new Promise<PrerenderResult>((resolve, reject) => {
      execFile(
        process.execPath,
        [runnerPath, configJson],
        { env: { ...process.env, ...env }, cwd: root, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (stderr) process.stderr.write(stderr);
          if (error) {
            reject(new Error(`Prerender child process failed: ${error.message}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error(`Failed to parse prerender output: ${stdout}`));
          }
        },
      );
    });

    // Log results in the parent process
    for (const path of result.rendered) {
      const outputFile = path === "/" ? "index.html" : `${path.slice(1)}.html`;
      voidLog(`prerender \x1b[36m${outputFile}\x1b[39m`);
    }
    for (const { path, error } of result.failed) {
      voidWarn(`prerender ${path} failed: ${error}`);
    }

    return result;
  } finally {
    try {
      unlinkSync(runnerPath);
    } catch {}
  }
}
