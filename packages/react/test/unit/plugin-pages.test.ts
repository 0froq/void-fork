import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { pagesPlugin } from '../../src/plugin-pages.ts';

const TMP = join(import.meta.dirname, '__tmp_pages_plugin__');
const PAGES_DIR = join(TMP, 'pages');

type HookWithHandler<T> = { handler: T };
type PagesPluginHooks = {
  config?:
    | ((config: Record<string, unknown>, env: { command: 'serve' | 'build' }) => unknown)
    | HookWithHandler<
        (config: Record<string, unknown>, env: { command: 'serve' | 'build' }) => unknown
      >;
};

function loadServeConfig(): Record<string, unknown> {
  mkdirSync(PAGES_DIR, { recursive: true });
  const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
  if (typeof plugin.config === 'function') {
    return plugin.config({}, { command: 'serve' }) as Record<string, unknown>;
  }
  return plugin.config?.handler({}, { command: 'serve' }) as Record<string, unknown>;
}

describe('pagesPlugin dev config', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('pre-optimizes React dependencies in the Cloudflare worker environment', () => {
    const config = loadServeConfig();

    expect(config).toMatchObject({
      environments: {
        void_worker: {
          optimizeDeps: {
            exclude: ['@void/react'],
            include: expect.arrayContaining(['react', 'react-dom', 'react-dom/server']),
          },
        },
      },
    });
  });
});
