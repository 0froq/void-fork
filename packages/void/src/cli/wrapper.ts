import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { build, type UserConfig } from "vite";

export interface WrapperFeatures {
  /** Absolute path to the framework's original worker entry. */
  originalEntry: string;
  /** Auth providers (kept for interface compat, no longer used by wrapper). */
  auth: string[] | null;
  /** Cron job definitions (from scanJobsSync). */
  crons: { name: string; filePath: string; crons: string[] }[];
  /** Queue consumer definitions (from scanQueuesSync). */
  queues: { name: string; filePath: string; bindingName: string }[];
}

export interface WrapperResult {
  /** Filename of the bundled wrapper entry module. */
  entryFilename: string;
  /** Absolute path to the directory containing the bundled wrapper. */
  outputDir: string;
}

/**
 * Bundle an entry module targeting workerd.
 *
 * Uses a temp directory as build root so Vite won't load the project's
 * vite.config.ts. Externalizes all `cloudflare:` and `node:` imports
 * (provided by the runtime).
 */
async function bundleForWorkerd(
  tmpDir: string,
  entry: string,
  fileName: string,
  resolve?: UserConfig["resolve"],
): Promise<WrapperResult> {
  const outDir = join(tmpDir, "out");
  await build({
    root: tmpDir,
    logLevel: "silent",
    build: {
      outDir,
      emptyOutDir: true,
      lib: {
        entry,
        formats: ["es"],
        fileName,
      },
      rollupOptions: {
        external: [/^cloudflare:/, /^node:/],
        output: {
          // Workers for Platforms restricts caches.default access.
          // Stub it so framework code (e.g. SvelteKit) that uses it doesn't throw.
          banner: [
            "const __noopCache = {",
            "  match() { return Promise.resolve(undefined); },",
            "  put() { return Promise.resolve(); },",
            "  delete() { return Promise.resolve(false); },",
            "};",
            "globalThis.caches = { default: __noopCache, open() { return Promise.resolve(__noopCache); } };",
          ].join("\n"),
        },
      },
      minify: false,
      target: "esnext",
    },
    resolve,
  });

  // Read actual output filename from the output directory
  const outFiles = readdirSync(outDir).filter((f) => f.startsWith(fileName));
  const entryFilename = outFiles[0] ?? `${fileName}.mjs`;

  return { entryFilename, outputDir: outDir };
}

/**
 * Determine whether a wrapper is needed based on the features.
 */
export function needsWrapper(features: WrapperFeatures): boolean {
  return features.crons.length > 0 || features.queues.length > 0;
}

export interface GeneratedWrapper {
  /** Absolute path to the generated wrapper entry. */
  entryPath: string;
  /** Resolve alias mapping `__ORIGINAL_WORKER__` to the real entry. */
  resolveAlias: Record<string, string>;
}

/**
 * Generate wrapper source files (no bundling).
 *
 * Writes the wrapper entry + scheduled/queue handler modules to
 * `.void/wrapper/`. The caller is responsible for bundling the
 * returned entry path via `bundleEntry()`.
 */
export function generateWrapper(root: string, features: WrapperFeatures): GeneratedWrapper {
  const tmpDir = join(root, ".void", "wrapper");
  mkdirSync(tmpDir, { recursive: true });

  const entrySource = generateWrapperSource(root, tmpDir, features);
  const entryPath = join(tmpDir, "entry.ts");
  writeFileSync(entryPath, entrySource);

  if (features.crons.length > 0) {
    writeFileSync(join(tmpDir, "scheduled.ts"), generateScheduledSource(root, features.crons));
  }

  if (features.queues.length > 0) {
    writeFileSync(join(tmpDir, "queue.ts"), generateQueueSource(root, features.queues));
  }

  return {
    entryPath,
    resolveAlias: { __ORIGINAL_WORKER__: features.originalEntry },
  };
}

/**
 * Bundle a worker entry into a self-contained module.
 *
 * Used for:
 * - Frameworks with unbundled bare imports (e.g. SvelteKit)
 * - Generated wrapper entries that reference cron/queue source files
 */
export async function bundleEntry(
  root: string,
  entry: string,
  resolve?: UserConfig["resolve"],
): Promise<WrapperResult> {
  const tmpDir = join(root, ".void", "bundle");
  mkdirSync(tmpDir, { recursive: true });
  return bundleForWorkerd(tmpDir, entry, "index", resolve);
}

/**
 * Clean up generated wrapper/bundle files.
 */
export function cleanupWrapper(root: string): void {
  rmSync(join(root, ".void"), { recursive: true, force: true });
}

// ─── Source Generators ─────────────────────────────────────────────

function generateWrapperSource(root: string, tmpDir: string, features: WrapperFeatures): string {
  const lines: string[] = [];

  lines.push(`import original from "__ORIGINAL_WORKER__";`);

  if (features.crons.length > 0) {
    lines.push(`import { handleScheduled } from "./scheduled.ts";`);
  }
  if (features.queues.length > 0) {
    lines.push(`import { handleQueue } from "./queue.ts";`);
  }

  lines.push("");

  if (features.crons.length > 0) {
    lines.push("async function wrappedFetch(request, env, ctx) {");
    lines.push("  const url = new URL(request.url);");
    lines.push('  if (request.method === "POST" && url.pathname === "/__scheduled") {');
    lines.push("    try {");
    lines.push("      const { cron, scheduledTime } = await request.json();");
    lines.push("      const controller = { cron, scheduledTime, noRetry() {} };");
    lines.push("      await handleScheduled(controller, env, ctx);");
    lines.push("      return new Response(JSON.stringify({ ok: true }), {");
    lines.push('        headers: { "Content-Type": "application/json" },');
    lines.push("      });");
    lines.push("    } catch (err) {");
    lines.push("      return new Response(JSON.stringify({ error: String(err) }), {");
    lines.push("        status: 500,");
    lines.push('        headers: { "Content-Type": "application/json" },');
    lines.push("      });");
    lines.push("    }");
    lines.push("  }");
    lines.push("  return original.fetch(request, env, ctx);");
    lines.push("}");
    lines.push("");
  }

  lines.push("export default {");

  // fetch handler — when crons exist, wrap to intercept /__scheduled;
  // otherwise pass through to the original worker.
  if (features.crons.length > 0) {
    lines.push("  fetch: wrappedFetch,");
  } else {
    lines.push("  fetch: original.fetch,");
  }

  // scheduled handler
  if (features.crons.length > 0) {
    lines.push("  scheduled: handleScheduled,");
  }

  // queue handler
  if (features.queues.length > 0) {
    lines.push("  queue: handleQueue,");
  }

  lines.push("};");

  return lines.join("\n");
}

function generateScheduledSource(root: string, crons: WrapperFeatures["crons"]): string {
  const lines: string[] = [];

  // Import cron handler files
  for (let i = 0; i < crons.length; i++) {
    const absPath = join(root, "crons", crons[i].filePath);
    lines.push(`import handler${i} from "${absPath}";`);
  }

  lines.push("");
  lines.push("export async function handleScheduled(controller, env, ctx) {");
  lines.push("  switch (controller.cron) {");

  for (let i = 0; i < crons.length; i++) {
    for (const expr of crons[i].crons) {
      lines.push(`    case ${JSON.stringify(expr)}:`);
    }
    lines.push(`      if (typeof handler${i} === "function") {`);
    lines.push(`        await handler${i}(controller, env, ctx);`);
    lines.push(`      } else if (handler${i} && typeof handler${i}.default === "function") {`);
    lines.push(`        await handler${i}.default(controller, env, ctx);`);
    lines.push(`      }`);
    lines.push(`      return;`);
  }

  lines.push("  }");
  lines.push("}");

  return lines.join("\n");
}

function generateQueueSource(root: string, queues: WrapperFeatures["queues"]): string {
  const lines: string[] = [];

  // Import queue handler files
  for (let i = 0; i < queues.length; i++) {
    const absPath = join(root, "queues", queues[i].filePath);
    lines.push(`import handler${i} from "${absPath}";`);
  }

  lines.push("");
  lines.push("export async function handleQueue(batch, env, ctx) {");
  lines.push("  const queueSuffix = batch.queue;");
  lines.push("  const messages = [...batch.messages].map(m => ({");
  lines.push("    id: m.id,");
  lines.push("    timestamp: m.timestamp.toISOString(),");
  lines.push("    body: m.body,");
  lines.push("    attempts: m.attempts,");
  lines.push("  }));");
  lines.push("  const payload = { queue: queueSuffix, messages };");

  for (let i = 0; i < queues.length; i++) {
    const name = queues[i].name;
    lines.push("");
    lines.push(
      `  if (queueSuffix === ${JSON.stringify(name)} || queueSuffix.endsWith("-" + ${JSON.stringify(name)})) {`,
    );
    lines.push(`    if (typeof handler${i} === "function") {`);
    lines.push(`      await handler${i}(payload, env);`);
    lines.push(`    } else if (handler${i} && typeof handler${i}.default === "function") {`);
    lines.push(`      await handler${i}.default(payload, env);`);
    lines.push(`    }`);
    lines.push(`    return;`);
    lines.push(`  }`);
  }

  lines.push("}");

  return lines.join("\n");
}
