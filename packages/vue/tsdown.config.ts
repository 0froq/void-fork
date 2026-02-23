import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime/index.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: ["vue", "vue/server-renderer", "vite", "void", "@vitejs/plugin-vue"],
});
