import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { voidPlugin } from "void";

export default defineConfig({
  adapter: cloudflare({
    platformProxy: {
      persist: { path: ".void/v3" },
    },
  }),
  vite: {
    plugins: [voidPlugin()],
  },
});
