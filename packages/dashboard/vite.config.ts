import { defineConfig } from "vite";
import voidPlugin from "void";
import { voidVue } from "@void-x/vue/plugin";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwind(), voidPlugin(), voidVue()],
});
