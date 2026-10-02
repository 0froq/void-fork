import { describe, expect, it } from 'vite-plus/test';
import { interpolateRouteParams } from '../../src/runtime/route-url.ts';

describe('route URL interpolation', () => {
  it('expands catch-all segments and encodes each path component', () => {
    expect(interpolateRouteParams('/files/:path{.+}', { path: 'docs/start ?#%.md' })).toBe(
      '/files/docs/start%20%3F%23%25.md',
    );
  });

  it('matches whole parameter names in route order', () => {
    expect(interpolateRouteParams('/:id2/:id/:id', { id: 'a/b', id2: 'two' })).toBe(
      '/two/a%2Fb/a%2Fb',
    );
  });

  it('preserves missing parameters, literal text, queries and fragments', () => {
    expect(interpolateRouteParams('/x:id/:id/:missing?next=/:id#/:id', { id: 'one' })).toBe(
      '/x:id/one/:missing?next=/:id#/:id',
    );
    expect(interpolateRouteParams('/:id', undefined)).toBe('/:id');
    expect(interpolateRouteParams('/:toString', {})).toBe('/:toString');
  });
});
