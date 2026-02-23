import { defineConfig } from "vite";
import voidPlugin from "void";
import { voidVue } from "@voidcloud/vue/plugin";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwind(), voidPlugin(), voidVue()],
});
