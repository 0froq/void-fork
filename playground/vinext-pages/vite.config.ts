import { defineConfig } from "vite";
import vinext from "vinext";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin(), vinext()],
});
