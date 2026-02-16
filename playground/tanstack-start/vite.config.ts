import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [
    // viteCloud wraps @cloudflare/vite-plugin — must come before tanstackStart
    viteCloud(),
    tanstackStart(),
    react(),
  ],
});
