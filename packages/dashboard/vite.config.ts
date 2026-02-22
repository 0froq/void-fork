import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudVue } from "@vite-cloud/vue/plugin";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwind(), viteCloud(), viteCloudVue()],
});
