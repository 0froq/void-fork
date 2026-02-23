import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: ["solid-js", "solid-js/web", "solid-js/store", "vite", "void", "vite-plugin-solid"],
});
