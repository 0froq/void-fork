import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSolid } from "@void/solid/plugin";

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
