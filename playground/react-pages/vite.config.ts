import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudReact } from "@vite-cloud/react/plugin";

export default defineConfig({
  plugins: [viteCloud(), viteCloudReact()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
