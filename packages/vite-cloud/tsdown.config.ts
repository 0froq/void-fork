import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime/handler.ts", "src/runtime/response.ts", "src/deploy/cli.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: ["vite", "@cloudflare/vite-plugin", "better-sqlite3"],
  inlineOnly: ["fdir", "picomatch", "tinyglobby", "estree-walker"],
});
