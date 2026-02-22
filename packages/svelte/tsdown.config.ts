import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: [
    "svelte",
    "svelte/*",
    "vite",
    "vite-cloud",
    "vite-cloud/*",
    "@sveltejs/vite-plugin-svelte",
  ],
});
