import { defineConfig } from "vite";
import voidPlugin from "void";
import { voidVue } from "@voidcloud/vue/plugin";

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
