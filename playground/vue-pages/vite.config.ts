import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudVue } from "@vite-cloud/vue/plugin";

export default defineConfig({
  plugins: [viteCloud(), viteCloudVue()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
