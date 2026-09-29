import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { migrateLegacyVoidConfig } from '../../src/cli/migrate.ts';

const root = join(import.meta.dirname, '.tmp-framework-config-migrate-test');

function setup(file: string, source: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'wrangler.jsonc'), '{"name":"app","compatibility_date":"2026-02-24"}');
  writeFileSync(join(root, file), source);
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('framework config migration', () => {
  it('wires both SvelteKit build and local proxy to the generated config', () => {
    setup(
      'vite.config.ts',
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter() };\n",
    );
    expect(migrateLegacyVoidConfig(root)).toBe(true);
    const source = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(source).toContain("config: './.void-wrangler.jsonc'");
    expect(source).toContain("platformProxy: { configPath: './.void-wrangler.jsonc' }");
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    expect(readFileSync(join(root, '.void/config-migration/vite.config.ts'), 'utf8')).toContain(
      'adapter()',
    );
  });

  it('wires a default Astro adapter and Nitro Cloudflare dev module', () => {
    setup(
      'astro.config.mjs',
      "import cloudflare from '@astrojs/cloudflare';\nexport default { adapter: cloudflare() };\n",
    );
    migrateLegacyVoidConfig(root);
    expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toContain(
      "configPath: './.void-wrangler.jsonc'",
    );

    setup(
      'vite.config.ts',
      "export default { nitro: { preset: 'cloudflare-module', modules: ['nitro-cloudflare-dev'] } };\n",
    );
    migrateLegacyVoidConfig(root);
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain(
      "cloudflareDev: { configPath: './.void-wrangler.jsonc' }",
    );
  });

  it('preserves custom SvelteKit adapter options while migrating an explicit path', () => {
    setup(
      'vite.config.ts',
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter({ fallback: 'spa', config: './wrangler.jsonc' }) };\n",
    );
    expect(migrateLegacyVoidConfig(root)).toBe(true);
    const source = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(source).toContain("fallback: 'spa'");
    expect(source).toContain("config: './.void-wrangler.jsonc'");
    expect(source).toContain("platformProxy: { configPath: './.void-wrangler.jsonc' }");
  });

  it('leaves unsupported dynamic adapter options and root config intact', () => {
    setup(
      'vite.config.ts',
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter({ fallback: 'spa' }) };\n",
    );
    writeFileSync(
      join(root, 'vite.config.ts'),
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter(options) };\n",
    );
    expect(() => migrateLegacyVoidConfig(root)).toThrow('Update vite.config.ts');
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(true);
    expect(existsSync(join(root, 'void.config.ts'))).toBe(false);
  });
});
