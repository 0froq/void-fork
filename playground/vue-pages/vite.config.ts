import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudVue } from "@vite-cloud/vue";

export default defineConfig({
  plugins: [viteCloud(), ...viteCloudVue()],
});
