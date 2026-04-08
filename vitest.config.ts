import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = {
  // cloudflare:workers is only available in the Workers runtime.
  // Provide a lightweight stub so tests can import modules that use DurableObject.
  'cloudflare:workers': fileURLToPath(
    new URL('packages/api/test/__mocks__/cloudflare-workers.ts', import.meta.url),
  ),
};

export default defineConfig({
  resolve: { alias },
  test: {
    silent: 'passed-only',
    projects: [
      // Unit tests + other packages (no special setup needed)
      {
        resolve: { alias },
        test: {
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/api/test/integration/**'],
        },
      },
      // API integration tests (need createDb mock via setup file)
      {
        resolve: { alias },
        test: {
          name: 'api-integration',
          include: ['packages/api/test/integration/**/*.test.ts'],
          globalSetup: ['packages/api/test/integration/global-setup.ts'],
          setupFiles: ['packages/api/test/integration/setup.ts'],
          ...(process.env.VOID_TEST_DATABASE_URL ? { fileParallelism: false } : {}),
        },
      },
    ],
  },
});
