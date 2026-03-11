import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
