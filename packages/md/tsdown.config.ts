import { defineConfig } from "tsdown";
import { cpSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts", "src/runtime/index.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: ["vite", "void", "vue"],
  onSuccess() {
    cpSync("src/theme", "dist/theme", { recursive: true });
  },
});
