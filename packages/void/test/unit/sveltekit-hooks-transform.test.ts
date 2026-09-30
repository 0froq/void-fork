import { parseSync } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { injectSvelteKitHooks } from '../../src/sveltekit-hooks-transform.ts';

describe('SvelteKit generated hook injection', () => {
  it('targets get_hooks even when another function returns an object first', () => {
    const source = `function earlier() { return { untouched: true }; }
export async function get_hooks ( ) {
  let handle;
  function nested() { return { nested: true }; }
  return { handle };
}`;
    const result = injectSvelteKitHooks(source, 'internal.js', '/trigger.js');
    expect(result).toBeDefined();
    expect(result!.code).toContain('function earlier() { return { untouched: true }; }');
    expect(result!.code).toContain('function nested() { return { nested: true }; }');
    expect(result!.code.indexOf('const __origHandle')).toBeGreaterThan(
      result!.code.indexOf('function nested'),
    );
    expect(result!.code).toContain('await import("/trigger.js")');
    expect(() => parseSync('internal.js', result!.code)).not.toThrow();
  });

  it('fails when the generated hook shape changes', () => {
    expect(() =>
      injectSvelteKitHooks('export const get_hooks = 1;', 'internal.js', '/trigger.js'),
    ).toThrow('Expected one generated get_hooks function');
  });
});
