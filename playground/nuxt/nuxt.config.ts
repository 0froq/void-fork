import { voidPlugin } from "void";

export default defineNuxtConfig({
  compatibilityDate: "2026-02-24",
  nitro: {
    preset: "cloudflare-module",
    cloudflareDev: {
      persistDir: ".void/v3",
    },
  },
  modules: ["nitro-cloudflare-dev"],
  vite: {
    plugins: [voidPlugin()],
  },
});
