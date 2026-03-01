import { resolve } from "node:path";
import { builtinModules } from "node:module";
import { defineConfig, esmExternalRequirePlugin } from "vite";
import { voidPlugin } from "void";
import { voidVue } from "@void-x/vue";
import tailwind from "@tailwindcss/vite";

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  plugins: [
    tailwind(),
    voidPlugin({
      persistTo: resolve(__dirname, "../api/.wrangler/state"),
      auxiliaryWorkers: [{ configPath: resolve(__dirname, "../api/wrangler.jsonc") }],
    }),
    voidVue(),
  ],
  environments: {
    void_dashboard: {
      build: {
        rolldownOptions: {
          plugins: [
            esmExternalRequirePlugin({
              external: nodeBuiltins,
              skipDuplicateCheck: true,
            }),
          ],
        },
      },
    },
  },
});
