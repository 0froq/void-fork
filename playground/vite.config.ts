import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import viteCloud from "vite-plugin-cloud";

export default defineConfig({
  plugins: [react(), viteCloud()],
});
