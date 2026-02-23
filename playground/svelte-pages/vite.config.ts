import { defineConfig } from "vite";
import voidPlugin from "void";
import { voidSvelte } from "@voidcloud/svelte/plugin";

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
