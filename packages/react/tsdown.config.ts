import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime/index.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/server",
    "react-dom/client",
    "vite",
    "vite-cloud",
    "@vitejs/plugin-react",
  ],
});
