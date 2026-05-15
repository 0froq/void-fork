import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

type MockCloudflarePlugin = Plugin & {
  api: {
    pluginConfig: MockCloudflarePluginConfig;
  };
};

vi.mock('@cloudflare/vite-plugin', () => ({
  cloudflare(pluginConfig: MockCloudflarePluginConfig): Array<MockCloudflarePlugin> {
    return [
      {
        name: 'mock:cloudflare',
        api: { pluginConfig },
      },
    ];
  },
}));

const tempDirs: Array<string> = [];

function createPagesProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-dev-assets-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'index.tsx'),
    'export default function Page() { return null; }',
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('voidPlugin dev asset routing', () => {
  it('keeps page requests on the worker while letting Vite internals bypass it', async () => {
    const root = createPagesProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const { voidPlugin } = await import('../../src/index.ts');
    const plugins = voidPlugin();

    const envPlugin = plugins.find((plugin) => plugin.name === 'void:env');
    const config = getHookHandler(envPlugin?.config) as (
      config: import('vite').UserConfig,
      env: import('vite').ConfigEnv,
    ) => void;
    config({}, { command: 'serve', mode: 'development' });

    const cloudflarePlugin = plugins.find(
      (plugin): plugin is MockCloudflarePlugin => plugin.name === 'mock:cloudflare',
    );
    if (!cloudflarePlugin) {
      throw new Error('Expected mocked Cloudflare plugin.');
    }

    const merged = cloudflarePlugin.api.pluginConfig.config({});
    const assets = merged.assets as { run_worker_first?: Array<string> } | undefined;

    expect(assets?.run_worker_first).toEqual([
      '!/@vite/*',
      '!/@id/*',
      '!/@fs/*',
      '!/@react-refresh',
      '!/@svelte/*',
      '!/node_modules/*',
      '!/__uno.css',
      '/**',
    ]);
  });
});
