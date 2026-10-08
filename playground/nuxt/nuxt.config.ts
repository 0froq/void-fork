import { resolve } from 'pathslash';
import type { PluginOption } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineNuxtConfig({
  compatibilityDate: '2026-02-24',
  nitro: {
    preset: 'cloudflare-module',
    cloudflareDev: { configPath: './.void-wrangler.jsonc' },
    // Remove when Nuxt ships https://github.com/nuxt/nuxt/commit/21657c6fcf.
    externals: {
      inline: [/[\\/]node_modules[\\/]nuxt[\\/]dist[\\/]/],
    },
    alias: {
      // Nitro has its own bundler that doesn't use Vite aliases.
      // Duplicate @schema here so Nitro can resolve it.
      '@schema': resolve(import.meta.dirname, 'db/schema.ts'),
    },
  },
  vite: {
    plugins: [voidPlugin() as unknown as PluginOption],
  },
});
