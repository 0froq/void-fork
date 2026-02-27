import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: false,
  clean: true,
  minify: true,
  inlineOnly: ["@clack/prompts", "@clack/core", "sisteransi", "picocolors"],
});
