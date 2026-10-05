import { parseSync } from 'vite';
import { describe, expect, it, vi } from 'vite-plus/test';
import { getRawRuntimeEnv } from '../../src/runtime/env-raw.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
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

  it.each([2, 3])('uses Kit %i adapter bindings for requests and dev triggers', async (major) => {
    const env = { name: `Kit ${major}` };
    const originalHandle = vi.fn(() => new Response(String(getRawRuntimeEnv().name)));
    const dispatch = vi.fn((request: Request, bindings: unknown) => {
      expect(bindings).toBe(env);
      expect(getRawRuntimeEnv()).toBe(env);
      return request.url.endsWith('/__void/scheduled') ? new Response('scheduled') : null;
    });
    const load = vi.fn(async (id: string) => {
      if (id === 'void/_env') {
        return { withRuntimeEnv };
      }
      if (id === '/trigger.js') {
        return { handleDevTrigger: dispatch };
      }
      if (id === 'cloudflare:workers') {
        return { env };
      }
      throw new Error(`Unexpected import: ${id}`);
    });
    const source = `export async function get_hooks() {
      let handle = originalHandle;
      return { handle };
    }`;
    const result = injectSvelteKitHooks(source, 'internal.js', '/trigger.js')!;
    // Execute the production transform while supplying its module imports.
    const getHooks = new Function(
      'load',
      'originalHandle',
      `${result.code.replace(/^export /gm, '').replaceAll('import(', 'load(')}; return get_hooks;`,
    )(load, originalHandle) as () => Promise<{
      handle: (options: {
        event: { request: Request; platform?: { env: typeof env } };
      }) => Promise<Response>;
    }>;
    const { handle } = await getHooks();
    const event = (pathname: string) => ({
      request: new Request(`https://example.com${pathname}`),
      ...(major === 2 ? { platform: { env } } : {}),
    });
    expect(await (await handle({ event: event('/') })).text()).toBe(`Kit ${major}`);
    expect(await (await handle({ event: event('/__void/scheduled') })).text()).toBe('scheduled');
    expect(originalHandle).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.some(([id]) => id === 'cloudflare:workers')).toBe(major === 3);
  });
});
