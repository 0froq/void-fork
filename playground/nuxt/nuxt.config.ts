import { voidPlugin } from "void";

export default defineNuxtConfig({
  compatibilityDate: "2026-02-24",
  nitro: {
    preset: "cloudflare-module",
  },
  modules: ["nitro-cloudflare-dev"],
  vite: {
    plugins: [voidPlugin() as any],
  },
});
