import { describe, expect, it } from 'vitest';
import { buildVariantOriginalUrl } from '../../src/variant-key.ts';

/**
 * The variant key for ISR is derived from the original request URL on a
 * rewrite. Without a query-allowlist, varying any param (`?utm=…`, `?cb=…`)
 * fans out cache slots and forces re-renders — Brook's DoS scenario in
 * platform PR #87. The fix: by default drop ALL query params from the
 * variant URL, and let users opt specific params back in per-pathname.
 */
describe('buildVariantOriginalUrl — query normalization for ISR variant key', () => {
  it('strips every query param when no allowlist is configured', () => {
    const out = buildVariantOriginalUrl(
      'https://h.example/x?utm_source=tw&fbclid=abc&cb=1',
      '/x',
      undefined,
    );
    expect(out).toBe('https://h.example/x');
  });

  it('keeps only allowlisted params for a literal pathname match', () => {
    const out = buildVariantOriginalUrl(
      'https://h.example/search?q=void&utm_source=tw&page=2&cb=1',
      '/search',
      { '/search': ['q', 'page'] },
    );
    expect(out).toBe('https://h.example/search?page=2&q=void');
  });

  it('sorts allowlisted params for deterministic ordering', () => {
    // Same param set in different request orders must produce the same URL.
    const a = buildVariantOriginalUrl('https://h.example/x?b=2&a=1', '/x', { '/x': ['a', 'b'] });
    const b = buildVariantOriginalUrl('https://h.example/x?a=1&b=2', '/x', { '/x': ['a', 'b'] });
    expect(a).toBe(b);
    expect(a).toBe('https://h.example/x?a=1&b=2');
  });

  it('preserves multi-valued allowlisted params in input order', () => {
    const out = buildVariantOriginalUrl('https://h.example/x?q=1&q=2&utm=x', '/x', {
      '/x': ['q'],
    });
    expect(out).toBe('https://h.example/x?q=1&q=2');
  });

  it('matches glob patterns and returns the first matching entry', () => {
    const allowlist = { '/blog/*': ['page'], '*': [] };
    const out = buildVariantOriginalUrl(
      'https://h.example/blog/hello?page=2&utm=x',
      '/blog/hello',
      allowlist,
    );
    expect(out).toBe('https://h.example/blog/hello?page=2');
  });

  it('falls through to the wildcard pattern as a default', () => {
    // No specific match → `*` entry with empty allowlist strips all params.
    const out = buildVariantOriginalUrl('https://h.example/about?utm=x&ref=tw', '/about', {
      '/blog/*': ['page'],
      '*': [],
    });
    expect(out).toBe('https://h.example/about');
  });

  it('passes through pre-rewrite pathname so allowlist is keyed on what the user requested', () => {
    // The route was rewritten from `/docs` to `/en/docs` — the allowlist key
    // is the user-facing path (pre-rewrite) since that's what they author.
    const out = buildVariantOriginalUrl('https://h.example/docs?q=void&utm=x', '/docs', {
      '/docs': ['q'],
    });
    expect(out).toBe('https://h.example/docs?q=void');
  });

  it('returns an unchanged URL when there are no params to strip', () => {
    const out = buildVariantOriginalUrl('https://h.example/x', '/x', undefined);
    expect(out).toBe('https://h.example/x');
  });
});
