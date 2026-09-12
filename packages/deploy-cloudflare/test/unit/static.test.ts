import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import {
  parseRootWranglerConfig,
  renderCloudflareStaticEntry,
  stageCloudflareStaticAssets,
  writeCloudflareStaticDeployConfig,
} from '../../src/index.ts';

describe('Cloudflare static deployment', () => {
  it('renders one deterministic shared-runtime entry', () => {
    expect(
      renderCloudflareStaticEntry({
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      }),
    ).toBe(
      `import { createStaticEdgeHandler } from "@void/edge";\n` +
        `export default createStaticEdgeHandler({"redirectRules":[{"source":"/old","destination":"/new","status":301}]});\n`,
    );
  });

  it('updates target fields while preserving comments and migration history', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-static-config-'));
    const configPath = join(root, 'wrangler.jsonc');
    mkdirSync(join(root, 'dist'));
    writeFileSync(
      configPath,
      `{
  // keep this comment
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],
  "assets": { "experimental_serve_directly": false }
}\n`,
    );

    const input = {
      configPath,
      name: 'my-site',
      accountId: 'account-id',
      main: '.void/deploy/cloudflare/edge.mjs',
      assetsDirectory: 'dist',
      compatibilityDate: '2026-09-11',
      assetConfig: { not_found_handling: 'single-page-application' as const },
    };
    expect(writeCloudflareStaticDeployConfig(input)).toBe(true);
    expect(writeCloudflareStaticDeployConfig(input)).toBe(false);

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toContain('// keep this comment');
    const parsed = parseRootWranglerConfig(configPath);
    expect(parsed).toMatchObject({
      name: 'my-site',
      account_id: 'account-id',
      main: '.void/deploy/cloudflare/edge.mjs',
      compatibility_date: '2026-09-11',
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      assets: {
        directory: 'dist',
        binding: 'ASSETS',
        run_worker_first: true,
        not_found_handling: 'single-page-application',
        html_handling: 'auto-trailing-slash',
        experimental_serve_directly: false,
      },
    });
  });

  it('stages assets without routing files that the thin Worker already consumed', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-static-assets-'));
    const sourceDirectory = join(root, 'public');
    const destinationDirectory = join(root, '.void/deploy/cloudflare/assets');
    mkdirSync(join(sourceDirectory, 'nested'), { recursive: true });
    writeFileSync(join(sourceDirectory, 'index.html'), '<h1>Home</h1>');
    writeFileSync(join(sourceDirectory, '_headers'), '/*\n  X-Test: yes\n');
    writeFileSync(join(sourceDirectory, '_redirects'), '/* /index.html 200\n');
    writeFileSync(join(sourceDirectory, '.assetsignore'), 'private/**\n');
    writeFileSync(join(sourceDirectory, 'nested/_redirects'), 'ordinary nested asset');

    stageCloudflareStaticAssets({ sourceDirectory, destinationDirectory });

    expect(readFileSync(join(destinationDirectory, 'index.html'), 'utf-8')).toBe('<h1>Home</h1>');
    expect(readFileSync(join(destinationDirectory, '.assetsignore'), 'utf-8')).toBe('private/**\n');
    expect(readFileSync(join(destinationDirectory, 'nested/_redirects'), 'utf-8')).toBe(
      'ordinary nested asset',
    );
    expect(existsSync(join(destinationDirectory, '_headers'))).toBe(false);
    expect(existsSync(join(destinationDirectory, '_redirects'))).toBe(false);

    writeFileSync(join(destinationDirectory, 'stale.txt'), 'stale');
    stageCloudflareStaticAssets({ sourceDirectory, destinationDirectory });
    expect(existsSync(join(destinationDirectory, 'stale.txt'))).toBe(false);
  });
});
