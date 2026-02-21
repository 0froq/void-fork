import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime/index.ts"],
  format: "esm",
  dts: { isolatedDeclarations: true },
  clean: true,
  external: ["vue", "vue/server-renderer", "vite", "vite-cloud", "@vitejs/plugin-vue"],
});
