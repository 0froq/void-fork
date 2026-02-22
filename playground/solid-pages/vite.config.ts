import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudSolid } from "@vite-cloud/solid/plugin";

export default defineConfig({
  plugins: [viteCloud(), viteCloudSolid()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
