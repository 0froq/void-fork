import { describe, it, expect, vi } from 'vitest';
import { applyRoutingRules, mergeQueryIntoLocation } from '../../src/routing-rules';

describe('applyRoutingRules', () => {
  it('returns null when no rules', () => {
    expect(applyRoutingRules('/foo')).toBeNull();
    expect(applyRoutingRules('/foo', [])).toBeNull();
  });

  it('returns null when no match', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301 }];
    expect(applyRoutingRules('/other', rules)).toBeNull();
  });

  it('returns redirect for 3xx rules', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301 }];
    const result = applyRoutingRules('/old', rules);
    expect(result).toEqual({ type: 'redirect', destination: '/new', status: 301 });
  });

  // Regression: 303 See Other is a valid redirect status but had no explicit
  // coverage. Exercise it through the full rule path so the framework →
  // platform → dispatch contract is pinned end-to-end for all accepted 3xx
  // codes (301/302/303/307/308).
  it('returns 303 redirect for status 303 rules', () => {
    const rules = [{ source: '/submit', destination: '/thanks', status: 303 }];
    const result = applyRoutingRules('/submit', rules);
    expect(result).toEqual({ type: 'redirect', destination: '/thanks', status: 303 });
  });

  it('returns rewrite for status 200 rules', () => {
    const rules = [{ source: '/docs', destination: '/en/docs', status: 200 }];
    const result = applyRoutingRules('/docs', rules);
    expect(result).toEqual({ type: 'rewrite', destination: '/en/docs' });
  });

  it('matches legacy * wildcard with :splat substitution', () => {
    const rules = [{ source: '/blog/*', destination: '/posts/:splat', status: 301 }];
    const result = applyRoutingRules('/blog/hello-world', rules);
    expect(result).toEqual({ type: 'redirect', destination: '/posts/hello-world', status: 301 });
  });

  it('supports named :param captures (single segment)', () => {
    const rules = [{ source: '/blog/:slug', destination: '/articles/:slug', status: 301 }];
    const result = applyRoutingRules('/blog/hello', rules);
    expect(result).toEqual({ type: 'redirect', destination: '/articles/hello', status: 301 });
  });

  it('named :param does not match across slashes', () => {
    const rules = [{ source: '/blog/:slug', destination: '/articles/:slug', status: 301 }];
    expect(applyRoutingRules('/blog/a/b', rules)).toBeNull();
  });

  it('supports multiple named captures', () => {
    const rules = [
      {
        source: '/blog/:author/:slug',
        destination: '/articles/:author/:slug',
        status: 301,
      },
    ];
    const result = applyRoutingRules('/blog/jane/post-1', rules);
    expect(result).toEqual({
      type: 'redirect',
      destination: '/articles/jane/post-1',
      status: 301,
    });
  });

  it('supports catch-all :name* captures', () => {
    const rules = [{ source: '/files/:path*', destination: '/storage/:path', status: 200 }];
    const result = applyRoutingRules('/files/a/b/c.txt', rules);
    expect(result).toEqual({ type: 'rewrite', destination: '/storage/a/b/c.txt' });
  });

  it('last match wins across redirects and rewrites', () => {
    const rules = [
      { source: '/page', destination: '/other', status: 302 },
      { source: '/page', destination: '/en/page', status: 200 },
    ];
    const result = applyRoutingRules('/page', rules);
    expect(result).toEqual({ type: 'rewrite', destination: '/en/page' });
  });

  it('redirect wins when it is the last match', () => {
    const rules = [
      { source: '/page', destination: '/en/page', status: 200 },
      { source: '/page', destination: '/other', status: 301 },
    ];
    const result = applyRoutingRules('/page', rules);
    expect(result).toEqual({ type: 'redirect', destination: '/other', status: 301 });
  });

  it('leaves unknown :placeholders untouched in destination', () => {
    const rules = [{ source: '/old', destination: '/new/:ref', status: 301 }];
    const result = applyRoutingRules('/old', rules);
    expect(result).toEqual({ type: 'redirect', destination: '/new/:ref', status: 301 });
  });

  it('matches legacy rules with multiple anonymous wildcards', () => {
    const rules = [{ source: '/*/static/*', destination: '/x/:splat', status: 301 }];
    expect(applyRoutingRules('/app/static/logo.png', rules)).toEqual({
      type: 'redirect',
      destination: '/x/app',
      status: 301,
    });
  });

  it('returns null (not throws) when every rule has an invalid source', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rules = [{ source: '/:id/static/:id', destination: '/x', status: 301 }];
      expect(applyRoutingRules('/foo', rules)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  // Percent-encoded / non-ASCII paths come in as-is from `new URL().pathname`
  // (Cloudflare does not normalize them). `compilePattern` needs to produce a
  // regex that matches the raw pathname byte-for-byte; non-ASCII characters
  // are regex-literal and percent-triples have `%` which is not a regex
  // special, so both cases should compile and match without special handling.
  it('matches non-ASCII path segments literally', () => {
    const rules = [{ source: '/café/*', destination: '/fr/café/:splat', status: 301 }];
    expect(applyRoutingRules('/café/menu', rules)).toEqual({
      type: 'redirect',
      destination: '/fr/café/menu',
      status: 301,
    });
  });

  it('matches percent-encoded path segments literally', () => {
    const rules = [{ source: '/caf%C3%A9/*', destination: '/fr/caf%C3%A9/:splat', status: 200 }];
    expect(applyRoutingRules('/caf%C3%A9/menu', rules)).toEqual({
      type: 'rewrite',
      destination: '/fr/caf%C3%A9/menu',
    });
  });
});

describe('mergeQueryIntoLocation', () => {
  it('returns destination unchanged when no query to merge', () => {
    expect(mergeQueryIntoLocation('/new', '')).toBe('/new');
    expect(mergeQueryIntoLocation('/new', '?')).toBe('/new');
  });

  it('appends request query when destination has none', () => {
    expect(mergeQueryIntoLocation('/new', '?utm=x&id=5')).toBe('/new?utm=x&id=5');
  });

  it('destination query wins on per-key conflict', () => {
    expect(mergeQueryIntoLocation('/new?ref=internal', '?ref=external&utm=x')).toBe(
      '/new?ref=internal&utm=x',
    );
  });

  it('drops request query when destination has an explicit empty query', () => {
    expect(mergeQueryIntoLocation('/new?', '?utm=x&id=5')).toBe('/new');
    expect(mergeQueryIntoLocation('/new?#faq', '?utm=x&id=5')).toBe('/new#faq');
  });

  it('preserves destination-only params and adds request-only params', () => {
    expect(mergeQueryIntoLocation('/new?a=1', '?b=2')).toBe('/new?a=1&b=2');
  });

  it('preserves destination fragment when appending request query', () => {
    // Without fragment handling this would return `/new#faq?utm=x` which
    // browsers treat as fragment text — the utm param would be lost.
    expect(mergeQueryIntoLocation('/new#faq', '?utm=x')).toBe('/new?utm=x#faq');
  });

  it('preserves destination fragment when merging query params', () => {
    expect(mergeQueryIntoLocation('/new?a=1#faq', '?b=2')).toBe('/new?a=1&b=2#faq');
  });
});
