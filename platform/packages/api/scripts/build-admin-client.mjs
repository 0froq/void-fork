import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const source = (path) => fileURLToPath(new URL(path, `file://${repositoryRoot}/`));

await build({
  configFile: false,
  root: apiRoot,
  publicDir: false,
  resolve: {
    alias: {
      '@void/react/pages-client': source('packages/react/src/runtime/pages-client.ts'),
      '@void/react': source('packages/react/src/runtime/index.ts'),
      'void/pages-client': source('packages/void/src/pages/client.ts'),
      'void/pages-prefetch': source('packages/void/src/pages/prefetch.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    lib: {
      entry: source('platform/packages/api/src/admin/react/client.ts'),
      name: 'VoidAdmin',
      formats: ['iife'],
      fileName: () => 'admin-client.js',
    },
  },
});
