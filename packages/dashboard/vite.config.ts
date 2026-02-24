import { resolve } from "node:path";
import { defineConfig } from "vite";
import voidPlugin from "void";
import { voidVue } from "@void-x/vue";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tailwind(),
    voidPlugin({ persistTo: resolve(__dirname, "../api/.wrangler/state") }),
    voidVue(),
  ],
});
