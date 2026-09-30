import { parseSync } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { transformPgWorkerBundle } from '../../src/cli/pg-bundle-transform.ts';

const shim = 'var __require = (id) => { throw new Error(id); };';

describe('PostgreSQL migration bundle transform', () => {
  it('replaces parsed require nodes across output formatting variants', () => {
    const source = `import { createRequire } from 'node:module';
var __require = /* bundler annotation */ (() => createRequire(import.meta.url))();
const value = __require ( 'pgpass' );`;
    const transformed = transformPgWorkerBundle(source, 'bundle.mjs', shim);
    expect(transformed).toContain('const value = __voidPgpassNoop;');
    expect(transformed).toContain(shim);
    expect(transformed).not.toContain('createRequire');
    expect(() => parseSync('bundle.mjs', transformed)).not.toThrow();
  });

  it('fails closed when the emitted require shape changes', () => {
    expect(() =>
      transformPgWorkerBundle('const x = createRequire(import.meta.url);', 'bundle.mjs', shim),
    ).toThrow('Could not locate the generated require binding');
  });

  it('leaves unrelated bundles untouched', () => {
    const source = 'export const value = 1;';
    expect(transformPgWorkerBundle(source, 'bundle.mjs', shim)).toBe(source);
  });
});
