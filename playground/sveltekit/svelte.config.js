import adapter from '@sveltejs/adapter-cloudflare';
import { withVoidTSConfig } from 'void/sveltekit';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter(),
    typescript: {
      config: withVoidTSConfig(),
    },
  },
};

export default config;
