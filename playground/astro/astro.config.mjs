import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';
import { voidPlugin } from 'void';

export default defineConfig({
  adapter: cloudflare(),
  vite: {
    plugins: [voidPlugin()],
  },
});
