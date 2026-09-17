import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import spawn from 'cross-spawn';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('explicit ISR policy in real builds', () => {
  it.each(['server', 'static'])('disables ISR while preserving %s output', (output) => {
    const playground = createIsolatedPlayground(ROOT, 'playground/markdown-blog');
    try {
      const configPath = join(playground.root, 'void.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.output = output;
      config.routing = { ...config.routing, isr: false };
      writeFileSync(configPath, JSON.stringify(config));
      writeFileSync(
        join(playground.root, 'wrangler.jsonc'),
        JSON.stringify({ name: 'isr-policy-test', compatibility_date: '2026-02-24' }),
      );
      const build = spawn.sync(
        'vp',
        ['run', '--filter', `./${playground.workspacePath}`, 'build'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      );
      expect(build.status, `${build.stdout ?? ''}${build.stderr ?? ''}`).toBe(0);
      const entry = readFileSync(join(playground.root, '.void/entry.ts'), 'utf8');
      expect(entry).not.toContain('handleIsr');
      const generated = JSON.parse(
        readFileSync(join(playground.root, 'dist/ssr/wrangler.json'), 'utf8'),
      );
      expect(
        (generated.kv_namespaces ?? []).some(
          (binding: { binding: string }) => binding.binding === 'ISR_CACHE',
        ),
      ).toBe(false);
      if (output === 'static') {
        expect(existsSync(join(playground.root, 'dist/client/index.html'))).toBe(true);
      }
    } finally {
      playground.cleanup();
    }
  });
});
