import { describe, expect, it } from 'vitest';
import {
  isrCacheKey,
  isrCacheVariantPrefix,
  isrEdgeCacheUrl,
  isrEdgeCacheUrlForToken,
  splitIsrCacheKey,
} from '../../src/index';

/**
 * Hashing the variant token (instead of base64url-encoding the original URL)
 * meets two operational concerns:
 *
 *   1. KV is operator-readable. A reversible token (`btoa(originalUrl)`) lets
 *      anyone with KV list access recover the URL — including any sensitive
 *      query strings (`?token=…`, `?email=…`) that produced the variant.
 *   2. Variant tokens are used as KV-key suffixes. KV's 512-byte name limit
 *      can be approached if a deployment serves long URLs; a fixed-length
 *      hash bounds key length irrespective of input.
 */
describe('ISR variant token hashing', () => {
  function variantSuffix(key: string): string {
    const idx = key.indexOf('#rw=');
    expect(idx).toBeGreaterThan(-1);
    return key.slice(idx + '#rw='.length);
  }

  it('produces a fixed-length hex token regardless of URL length', () => {
    const short = isrCacheKey('p', 'd', '/x', 'https://h/');
    const long = isrCacheKey(
      'p',
      'd',
      '/x',
      'https://h/' + 'A'.repeat(4096) + '?q=' + 'B'.repeat(4096),
    );
    const a = variantSuffix(short);
    const b = variantSuffix(long);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(b).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeLessThanOrEqual(64); // bounded, not URL-length-dependent
  });

  it('does not embed any portion of the original URL in the token', () => {
    // Sentinel chosen so any base64url/identity scheme would surface it.
    const sentinel = 'leaky-secret-fragment';
    const key = isrCacheKey('p', 'd', '/x', `https://h/page?token=${sentinel}`);
    const token = variantSuffix(key);
    expect(token.toLowerCase()).not.toContain(sentinel.toLowerCase());
    // base64url of the URL would also contain the sentinel encoded — guard
    // against that too by checking a few likely encodings.
    expect(token).not.toContain('bGVha3k='.replace('=', '')); // partial b64
  });

  it('is deterministic — same URL produces the same token', () => {
    const a = isrCacheKey('p', 'd', '/x', 'https://h/foo');
    const b = isrCacheKey('p', 'd', '/x', 'https://h/foo');
    expect(a).toBe(b);
  });

  it('produces distinct tokens for distinct URLs', () => {
    const a = isrCacheKey('p', 'd', '/x', 'https://h/foo');
    const b = isrCacheKey('p', 'd', '/x', 'https://h/bar');
    expect(a).not.toBe(b);
  });

  it('splitIsrCacheKey returns the (opaque) variant token, not a URL', () => {
    const fullKey = isrCacheKey('p', 'd', '/x', 'https://h/foo');
    const tail = fullKey.slice(isrCacheVariantPrefix('p', 'd', '/x').length);
    // Reconstruct the part that splitIsrCacheKey actually consumes (the
    // suffix after the prefix), then call it on the full key form.
    void tail;
    const split = splitIsrCacheKey(fullKey.slice(`p/isr/v2/d/`.length));
    expect(split.variantToken).toMatch(/^[0-9a-f]+$/);
    expect(split.variantToken).not.toContain('https://');
  });

  it('isrEdgeCacheUrl and isrEdgeCacheUrlForToken agree for the same URL', () => {
    // The purger only knows the hashed token (URL is gone after hashing).
    // It must still reproduce the exact edge-cache URL the writer wrote.
    const original = 'https://app.void.app/docs?utm=x';
    const fromUrl = isrEdgeCacheUrl('app.void.app', '/en/docs', 'dpl_1', 'html', original);
    // Pull the token out of the writer's URL and feed it to the by-token
    // builder — they must produce byte-identical strings.
    const m = /__void_orig=([^&]+)/.exec(fromUrl);
    expect(m).not.toBeNull();
    const token = m![1]!;
    const fromToken = isrEdgeCacheUrlForToken('app.void.app', '/en/docs', 'dpl_1', 'html', token);
    expect(fromToken).toBe(fromUrl);
  });
});
