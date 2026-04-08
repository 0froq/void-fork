import { resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import { voidVue } from '@void/vue/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [
    tailwind(),
    voidPlugin({
      persistTo: resolve(__dirname, '../api/.wrangler/state'),
      auxiliaryWorkers: [{ configPath: resolve(__dirname, '../api/wrangler.jsonc') }],
    }),
    voidVue(),
  ],
});
