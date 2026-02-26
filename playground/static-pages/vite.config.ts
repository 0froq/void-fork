import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidVue } from "@void-x/vue";

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
