import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [react(), viteCloud({ auth: ["github", "google", "email"] })],
});
