import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { voidPlugin } from "void";

export default defineConfig({
  adapter: cloudflare(),
  vite: {
    plugins: [voidPlugin()],
  },
});
