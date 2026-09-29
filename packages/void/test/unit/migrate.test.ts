import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { migrateLegacyVoidConfig } from '../../src/cli/migrate.ts';
import { readConfig } from '../../src/config.ts';

const root = join(import.meta.dirname, '.tmp-migrate-test');

function setup(config: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'void.json'), config);
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('migrateLegacyVoidConfig', () => {
  it('preserves config values and keeps the original bytes in a backup', () => {
    const original =
      '{\n  "$schema": "./node_modules/void/schema.json",\n  "routing": { "isr": true },\n  "worker": { "compatibility_date": "2026-02-24" }\n}\n';
    setup(original);

    expect(migrateLegacyVoidConfig(root)).toBe(true);
    expect(existsSync(join(root, 'void.json'))).toBe(false);
    expect(readConfig(root)).toEqual({
      routing: { isr: true },
      worker: { compatibility_date: '2026-02-24' },
    });
    expect(readFileSync(join(root, '.void/config-migration/void.json'), 'utf8')).toBe(original);
    expect(migrateLegacyVoidConfig(root)).toBe(false);
  });

  it('leaves invalid JSON and an existing typed config untouched', () => {
    setup('{broken');
    expect(() => migrateLegacyVoidConfig(root)).toThrow('Invalid JSON');
    expect(readFileSync(join(root, 'void.json'), 'utf8')).toBe('{broken');

    setup('{"target":"node"}');
    writeFileSync(join(root, 'void.config.ts'), 'export default { target: "bun" };\n');
    expect(() => migrateLegacyVoidConfig(root)).toThrow('Both void.json and void.config.ts');
    expect(existsSync(join(root, 'void.json'))).toBe(true);
  });

  it('finishes an interrupted migration if the typed config matches', () => {
    setup('{"target":"node"}');
    migrateLegacyVoidConfig(root);
    writeFileSync(join(root, 'void.json'), '{"target":"node"}');

    expect(migrateLegacyVoidConfig(root)).toBe(true);
    expect(existsSync(join(root, 'void.json'))).toBe(false);
    expect(readConfig(root).target).toBe('node');
  });
});
