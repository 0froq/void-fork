import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';
import { withVoidTSConfig } from 'void/sveltekit';

export default defineConfig({
  plugins: [
    voidPlugin(),
    sveltekit({
      adapter: adapter({
        config: './.void-wrangler.jsonc',
        platformProxy: { configPath: './.void-wrangler.jsonc' },
      }),
      typescript: {
        config: withVoidTSConfig(),
      },
    }),
  ],
});
