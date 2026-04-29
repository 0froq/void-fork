import { describe, it, expect } from 'vitest';
import {
  compilePattern,
  matchLiteralPattern,
  matchPattern,
  matchPatternCaptures,
  substituteParams,
} from '../../src/pattern.ts';

describe('matchPattern', () => {
  it('matches exact path', () => {
    expect(matchPattern('/index.html', '/index.html')).toBe(true);
  });

  it('rejects non-matching exact path', () => {
    expect(matchPattern('/index.html', '/about.html')).toBe(false);
  });

  it('matches wildcard at end', () => {
    expect(matchPattern('/assets/*', '/assets/app.js')).toBe(true);
  });

  it('matches wildcard across slashes', () => {
    expect(matchPattern('/assets/*', '/assets/js/app.js')).toBe(true);
  });

  it('matches leading wildcard extension', () => {
    expect(matchPattern('/*.html', '/index.html')).toBe(true);
  });

  it('rejects wildcard extension mismatch', () => {
    expect(matchPattern('/*.html', '/app.js')).toBe(false);
  });

  it('matches catch-all wildcard', () => {
    expect(matchPattern('/*', '/any/path/here')).toBe(true);
  });

  it('matches root with catch-all', () => {
    expect(matchPattern('/*', '/')).toBe(true);
  });

  it('matches path with special regex chars', () => {
    expect(matchPattern('/foo.bar', '/foo.bar')).toBe(true);
  });

  it('rejects dot as regex wildcard', () => {
    // The . in the pattern is a literal dot, not regex wildcard
    expect(matchPattern('/foo.html', '/fooXhtml')).toBe(false);
  });
});

describe('compilePattern', () => {
  it('captures :name as single path segment', () => {
    const { regex, paramNames } = compilePattern('/blog/:slug');
    expect(paramNames).toEqual(['slug']);
    expect(regex.exec('/blog/hello')?.groups).toEqual({ slug: 'hello' });
    expect(regex.exec('/blog/hello/world')).toBeNull();
  });

  it('captures :name* as zero-or-more segments', () => {
    const { regex, paramNames } = compilePattern('/docs/:path*');
    expect(paramNames).toEqual(['path']);
    expect(regex.exec('/docs/a/b/c')?.groups).toEqual({ path: 'a/b/c' });
    expect(regex.exec('/docs/')?.groups).toEqual({ path: '' });
  });

  it('captures legacy * as splat', () => {
    const { regex, paramNames } = compilePattern('/assets/*');
    expect(paramNames).toEqual(['splat']);
    expect(regex.exec('/assets/js/app.js')?.groups).toEqual({ splat: 'js/app.js' });
  });

  it('captures middle * as only what actually matched, not prefix-slice', () => {
    const { regex } = compilePattern('/blog/*/edit');
    expect(regex.exec('/blog/hello/edit')?.groups).toEqual({ splat: 'hello' });
    expect(regex.exec('/blog/a/b/edit')?.groups).toEqual({ splat: 'a/b' });
    expect(regex.exec('/blog/hello')).toBeNull();
  });

  it('matches legacy patterns with multiple anonymous wildcards', () => {
    const { regex, paramNames } = compilePattern('/a/*/b/*');
    expect(paramNames).toEqual(['splat']);
    expect(regex.test('/a/x/b/y')).toBe(true);
    expect(regex.test('/a/x/c/y')).toBe(false);
  });

  it('captures multiple named params in one pattern', () => {
    const { regex, paramNames } = compilePattern('/blog/:author/:slug');
    expect(paramNames).toEqual(['author', 'slug']);
    expect(regex.exec('/blog/alice/hello')?.groups).toEqual({ author: 'alice', slug: 'hello' });
    expect(regex.exec('/blog/alice/hello/world')).toBeNull();
  });

  it('escapes regex-special characters in literals', () => {
    const { regex } = compilePattern('/foo.html');
    expect(regex.test('/foo.html')).toBe(true);
    expect(regex.test('/fooXhtml')).toBe(false);
  });

  it('treats bare colon (no name chars after) as literal', () => {
    const { regex, paramNames } = compilePattern('/foo:/bar');
    expect(paramNames).toEqual([]);
    expect(regex.test('/foo:/bar')).toBe(true);
    expect(regex.test('/fooX/bar')).toBe(false);
  });

  it('matchPattern supports legacy patterns with multiple anonymous wildcards', () => {
    expect(matchPattern('/a/*/b/*', '/a/x/b/y')).toBe(true);
    expect(matchPattern('/a/*/b/*', '/a/x/c/y')).toBe(false);
  });

  it('matchPatternCaptures returns the first legacy splat for multi-splat patterns', () => {
    expect(matchPatternCaptures('/a/*/b/*', '/a/x/b/y')).toEqual({ splat: 'x' });
  });

  it('returns cached CompiledPattern for repeated input', () => {
    const a = compilePattern('/cache-test/:id');
    const b = compilePattern('/cache-test/:id');
    expect(b).toBe(a);
  });
});

describe('matchPatternCaptures', () => {
  it('returns null when pattern does not match', () => {
    expect(matchPatternCaptures('/blog/:slug', '/articles/hello')).toBeNull();
  });

  it('returns captured groups on match', () => {
    expect(matchPatternCaptures('/blog/:author/:slug', '/blog/alice/hello')).toEqual({
      author: 'alice',
      slug: 'hello',
    });
  });

  it('returns empty object when pattern has no captures', () => {
    expect(matchPatternCaptures('/about', '/about')).toEqual({});
  });

  it('returns splat for legacy * pattern', () => {
    expect(matchPatternCaptures('/assets/*', '/assets/js/app.js')).toEqual({
      splat: 'js/app.js',
    });
  });
});

describe('matchLiteralPattern', () => {
  it('treats `:` as a literal character (no named capture)', () => {
    // `:health` would be a named capture in `matchPattern`, but the literal
    // matcher must keep the pre-feat/rewrites semantics where `:` was just a
    // regex-safe literal. Existing tenant header/revalidate configs may rely
    // on this (e.g. `/api/v1:health`, `:batchGet`-style URLs).
    expect(matchLiteralPattern('/api/v1:health', '/api/v1:health')).toBe(true);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1foo')).toBe(false);
  });

  it('still expands `*` to match any characters including slashes', () => {
    expect(matchLiteralPattern('/assets/*', '/assets/js/app.js')).toBe(true);
    expect(matchLiteralPattern('/assets/*', '/other/file')).toBe(false);
  });
});

describe('substituteParams', () => {
  it('substitutes :name tokens', () => {
    expect(substituteParams('/articles/:slug', { slug: 'hello' })).toBe('/articles/hello');
  });

  it('substitutes :name* tokens', () => {
    expect(substituteParams('/new/:path*', { path: 'a/b/c' })).toBe('/new/a/b/c');
  });

  it('substitutes :splat for legacy * destinations', () => {
    expect(substituteParams('/new/:splat', { splat: 'a/b' })).toBe('/new/a/b');
  });

  it('substitutes multiple tokens in one destination', () => {
    expect(substituteParams('/posts/:author/:slug', { author: 'alice', slug: 'hello' })).toBe(
      '/posts/alice/hello',
    );
  });

  it('leaves token untouched when param missing', () => {
    expect(substituteParams('/articles/:slug', {})).toBe('/articles/:slug');
  });

  it('leaves token untouched when :name* param missing', () => {
    expect(substituteParams('/new/:path*', {})).toBe('/new/:path*');
  });

  it('ignores extra params not referenced by destination', () => {
    expect(substituteParams('/articles/:slug', { slug: 'hi', extra: 'x' })).toBe('/articles/hi');
  });
});
