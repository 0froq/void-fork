import { defineConfig } from "tsdown";

const WORKERS_TYPES_REFERENCE = '/// <reference types="@cloudflare/workers-types" />';

function injectWorkersTypesReferencePlugin() {
  return {
    name: "vite-cloud:inject-workers-types-reference",
    // tsdown's declaration emit currently drops source-level triple-slash references.
    // Our public handler types use Cloudflare global types (D1Database, KVNamespace, etc.),
    // so we inject the reference into the emitted .d.mts to keep consumer DX zero-config.
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      for (const output of Object.values(bundle)) {
        // Only patch the public handler declaration entrypoint.
        if (output.fileName !== "runtime/handler.d.mts") continue;

        if (output.type === "asset") {
          const source = String(output.source ?? "");
          if (!source.startsWith(WORKERS_TYPES_REFERENCE)) {
            output.source = `${WORKERS_TYPES_REFERENCE}\n${source}`;
          }
          continue;
        }

        if (output.type === "chunk") {
          const code = String(output.code ?? "");
          if (!code.startsWith(WORKERS_TYPES_REFERENCE)) {
            output.code = `${WORKERS_TYPES_REFERENCE}\n${code}`;
          }
        }
      }
    },
  };
}

export default defineConfig({
  entry: ["src/index.ts", "src/runtime/handler.ts", "src/runtime/response.ts", "src/cli/cli.ts"],
  format: "esm",
  dts: true,
  clean: true,
  plugins: [injectWorkersTypesReferencePlugin()],
  external: ["vite", "@cloudflare/vite-plugin", "better-sqlite3"],
  inlineOnly: [
    "fdir",
    "picomatch",
    "tinyglobby",
    "estree-walker",
    "@clack/prompts",
    "@clack/core",
    "sisteransi",
    "picocolors",
  ],
});
