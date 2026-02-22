import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudSvelte } from "@vite-cloud/svelte/plugin";

export default defineConfig({
  plugins: [viteCloud(), viteCloudSvelte()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
