import { defineConfig } from "vite";
import voidPlugin from "void";
import { voidSolid } from "@voidcloud/solid/plugin";

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
