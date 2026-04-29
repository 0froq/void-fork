import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/env';
import {
  MAX_ISR_VARIANTS_PER_PATH,
  isrCacheKey,
  isStale,
  resolveRevalidateTtl,
  resolvePathTtl,
  shouldBypassIsr,
  isrCacheResponse,
  isrEdgeCacheKey,
  isrEdgeCacheKeyJson,
  serializeHeaders,
  packIsrValue,
  unpackIsrValue,
  extractPageDataFromHtml,
  normalizePageDataForJsonCache,
  writeIsrCache,
  type IsrCacheEntry,
} from '../../src/isr';

describe('isrCacheKey', () => {
  it('maps root path to __index__', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', '/')).toBe('proj_1/isr/v2/dpl_1/__index__');
  });

  it('strips leading slash', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', '/about')).toBe('proj_1/isr/v2/dpl_1/about');
  });

  it('strips trailing slash', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', '/about/')).toBe('proj_1/isr/v2/dpl_1/about');
  });

  it('handles nested paths', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', '/blog/hello-world')).toBe(
      'proj_1/isr/v2/dpl_1/blog/hello-world',
    );
  });

  it('handles path without leading slash', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', 'about')).toBe('proj_1/isr/v2/dpl_1/about');
  });

  // User code can branch on `c.isRewritten()` / `c.originalUrl()`; a direct
  // hit to /en/docs and a rewrite from /docs → /en/docs must not share a slot.
  it('appends a rewrite-variant token when originalUrl is provided', () => {
    const direct = isrCacheKey('proj_1', 'dpl_1', '/en/docs');
    const rewritten = isrCacheKey('proj_1', 'dpl_1', '/en/docs', 'https://host/docs');
    expect(direct).toBe('proj_1/isr/v2/dpl_1/en/docs');
    expect(rewritten).not.toBe(direct);
    expect(rewritten.startsWith('proj_1/isr/v2/dpl_1/en/docs#rw=')).toBe(true);
  });

  it('produces distinct keys for different originalUrl values', () => {
    const a = isrCacheKey('proj_1', 'dpl_1', '/en/docs', 'https://host/docs');
    const b = isrCacheKey('proj_1', 'dpl_1', '/en/docs', 'https://host/other');
    expect(a).not.toBe(b);
  });

  it('treats null originalUrl as a direct hit (backward-compatible key)', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', '/x', null)).toBe('proj_1/isr/v2/dpl_1/x');
    expect(isrCacheKey('proj_1', 'dpl_1', '/x', undefined)).toBe('proj_1/isr/v2/dpl_1/x');
  });
});

describe('ISR edge cache URL variants', () => {
  // The edge cache URL and the KV key must include the same rewrite-variant
  // token so both layers see the same direct-vs-rewritten split.
  it('appends __void_orig when originalUrl is provided', () => {
    const direct = isrEdgeCacheKey(
      new Request('https://app.void.app/en/docs'),
      '/en/docs',
      'dpl_1',
    );
    const rewritten = isrEdgeCacheKey(
      new Request('https://app.void.app/docs'),
      '/en/docs',
      'dpl_1',
      'https://app.void.app/docs',
    );
    expect(direct.url).toBe('https://app.void.app/en/docs?__void_isr=dpl_1');
    expect(
      rewritten.url.startsWith('https://app.void.app/en/docs?__void_isr=dpl_1&__void_orig='),
    ).toBe(true);
  });

  it('appends __void_orig on the JSON variant too', () => {
    const rewritten = isrEdgeCacheKeyJson(
      new Request('https://app.void.app/docs'),
      '/en/docs',
      'dpl_1',
      'https://app.void.app/docs',
    );
    expect(rewritten.url.includes('__void=json')).toBe(true);
    expect(rewritten.url.includes('__void_isr=dpl_1')).toBe(true);
    expect(rewritten.url.includes('__void_orig=')).toBe(true);
  });
});

describe('isStale', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when entry is fresh', () => {
    vi.setSystemTime(1000000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(false);
  });

  it('returns true when entry is expired', () => {
    vi.setSystemTime(1000000 + 61 * 1000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(true);
  });

  it('returns false at exact TTL boundary', () => {
    vi.setSystemTime(1000000 + 60 * 1000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(false);
  });
});

describe('resolveRevalidateTtl', () => {
  it('returns default when no header present', () => {
    const response = new Response('ok');
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });

  it('returns header value when present', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': '120' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(120);
  });

  it('returns 0 for opt-out header', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': '0' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(0);
  });

  it('returns default for invalid header value', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': 'abc' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });

  it('returns default for negative header value', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': '-5' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });
});

describe('resolvePathTtl', () => {
  it('returns 0 for undefined', () => {
    expect(resolvePathTtl(undefined, '/')).toBe(0);
  });

  it('returns the number for numeric revalidate', () => {
    expect(resolvePathTtl(60, '/anything')).toBe(60);
  });

  it('matches exact path in object', () => {
    expect(resolvePathTtl({ '/': 60, '*': 30 }, '/')).toBe(60);
  });

  it('matches glob pattern', () => {
    expect(resolvePathTtl({ '/docs/*': 120, '*': 30 }, '/docs/intro')).toBe(120);
  });

  it('returns 0 when no pattern matches', () => {
    expect(resolvePathTtl({ '/docs/*': 120 }, '/about')).toBe(0);
  });

  it('uses first-match-wins ordering', () => {
    expect(resolvePathTtl({ '/docs/*': 120, '*': 30 }, '/docs/intro')).toBe(120);
    expect(resolvePathTtl({ '*': 30, '/docs/*': 120 }, '/docs/intro')).toBe(30);
  });

  it('supports zero TTL for specific paths', () => {
    expect(resolvePathTtl({ '/user/*': 0, '*': 60 }, '/user/profile')).toBe(0);
  });
});

describe('shouldBypassIsr', () => {
  it('returns true when Cookie header is present', () => {
    const request = new Request('https://example.com', {
      headers: { Cookie: 'session=abc' },
    });
    expect(shouldBypassIsr(request)).toBe(true);
  });

  it('returns true when Authorization header is present', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(shouldBypassIsr(request)).toBe(true);
  });

  it('returns false for X-VoidPages header (uses JSON edge cache instead)', () => {
    const request = new Request('https://example.com', {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(shouldBypassIsr(request)).toBe(false);
  });

  it('returns false for plain GET request', () => {
    const request = new Request('https://example.com');
    expect(shouldBypassIsr(request)).toBe(false);
  });
});

describe('isrCacheResponse', () => {
  it('sets x-isr-cache: HIT with edge-cacheable headers for fresh entry', () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: { 'Content-Type': 'text/html' },
      createdAt: Date.now(),
      ttl: 60,
    };
    const response = isrCacheResponse(entry, false);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(response.headers.get('Content-Type')).toBe('text/html');
    const cc = response.headers.get('Cache-Control')!;
    expect(cc).toContain('public');
    expect(cc).toContain('s-maxage=');
    expect(cc).toContain('must-revalidate');
  });

  it('sets x-isr-cache: STALE with short edge TTL for stale entry', () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: Date.now() - 120000,
      ttl: 60,
    };
    const response = isrCacheResponse(entry, true);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=10, max-age=0, must-revalidate',
    );
  });

  it('caps stale edge TTL at entry.ttl for short ISR windows', () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: Date.now() - 10000,
      ttl: 5,
    };
    const response = isrCacheResponse(entry, true);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=5, max-age=0, must-revalidate',
    );
  });
});

describe('ISR edge cache keys', () => {
  it('adds the deployment id to HTML edge cache keys', () => {
    const request = new Request('https://app.void.app/about?q=1');
    const key = isrEdgeCacheKey(request, '/about', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/about?__void_isr=dpl_1');
    expect(key.method).toBe('GET');
  });

  it('canonicalizes trailing slashes for edge cache keys', () => {
    const request = new Request('https://app.void.app/about/');
    const key = isrEdgeCacheKey(request, '/about/', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/about?__void_isr=dpl_1');
  });

  it('adds JSON and deployment parameters to JSON edge cache keys', () => {
    const request = new Request('https://app.void.app/about?q=1');
    const key = isrEdgeCacheKeyJson(request, '/about', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/about?__void=json&__void_isr=dpl_1');
    expect(key.method).toBe('GET');
  });

  it('handles root path', () => {
    const request = new Request('https://app.void.app/');
    const key = isrEdgeCacheKeyJson(request, '/', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/?__void=json&__void_isr=dpl_1');
  });
});

describe('serializeHeaders', () => {
  it('skips x-void-page-data header', () => {
    const response = new Response('ok', {
      headers: {
        'content-type': 'text/html',
        'x-void-page-data': '{"component":"Index"}',
        'x-custom': 'keep',
      },
    });
    const result = serializeHeaders(response);
    expect(result['content-type']).toBe('text/html');
    expect(result['x-custom']).toBe('keep');
    expect(result['x-void-page-data']).toBeUndefined();
  });

  it('skips cache-control and x-isr-cache', () => {
    const response = new Response('ok', {
      headers: {
        'cache-control': 'public',
        'x-isr-cache': 'HIT',
        'content-type': 'text/html',
      },
    });
    const result = serializeHeaders(response);
    expect(result['cache-control']).toBeUndefined();
    expect(result['x-isr-cache']).toBeUndefined();
    expect(result['content-type']).toBe('text/html');
  });

  it('strips set-cookie to prevent cross-user session replay', () => {
    const response = new Response('ok', {
      headers: {
        'content-type': 'text/html',
        'set-cookie': 'session=abc123; Path=/; HttpOnly',
        'x-custom': 'keep',
      },
    });
    const result = serializeHeaders(response);
    expect(result['set-cookie']).toBeUndefined();
    expect(result['content-type']).toBe('text/html');
    expect(result['x-custom']).toBe('keep');
  });
});

describe('page data extraction', () => {
  it('extracts embedded page data from the JSON script tag', () => {
    const pageData = '{"component":"Index","props":{"title":"hello"}}';
    const html = `<html><body><script id="__VOID_PAGE_DATA__" type="application/json">${pageData}</script><div id="app"></div></body></html>`;
    expect(extractPageDataFromHtml(html)).toBe(pageData);
  });

  it('skips embedded payloads with deferred metadata', () => {
    const html =
      '<script id="__VOID_PAGE_DATA__" type="application/json">{"component":"Index","props":{},"deferred":["stats"],"deferredKeys":{"stats":"stats"}}</script>';
    expect(extractPageDataFromHtml(html)).toBeNull();
  });

  it('normalizes legacy header payloads and rejects deferred ones', () => {
    expect(normalizePageDataForJsonCache('{"component":"Index","props":{}}')).toBe(
      '{"component":"Index","props":{}}',
    );
    expect(
      normalizePageDataForJsonCache(
        '{"component":"Index","props":{},"deferred":["stats"],"deferredKeys":{"stats":"stats"}}',
      ),
    ).toBeNull();
  });
});

/**
 * `MAX_ISR_VARIANTS_PER_PATH` defends against fanout when an attacker varies
 * an *allowlisted* query param (the queryAllowlist already drops everything
 * else). Past the cap, new variants are not written — the worker still
 * renders fresh content per request, but KV growth and revalidation cost
 * stay bounded.
 */
describe('writeIsrCache — variant cap', () => {
  function createKvMock(seed: Map<string, ArrayBuffer> = new Map()): {
    env: Env;
    kvStore: Map<string, ArrayBuffer>;
  } {
    const kvStore = seed;
    const env = {
      ISR_CACHE: {
        getWithMetadata: async (key: string) => {
          const value = kvStore.get(key);
          return value
            ? { value, metadata: { s: 200, c: Date.now(), t: 60 } }
            : { value: null, metadata: null };
        },
        put: async (key: string, value: ArrayBuffer) => {
          kvStore.set(key, value);
        },
        delete: async (key: string) => {
          kvStore.delete(key);
        },
        list: async (opts: { prefix: string; limit?: number; cursor?: string }) => {
          const all = [...kvStore.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
          const limit = opts.limit ?? 1000;
          const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
          const slice = all.slice(start, start + limit);
          const list_complete = start + limit >= all.length;
          return {
            keys: slice.map((name) => ({ name })),
            list_complete,
            cursor: list_complete ? '' : String(start + limit),
          };
        },
      },
    } as unknown as Env;
    return { env, kvStore };
  }

  function seedVariants(kv: Map<string, ArrayBuffer>, count: number): void {
    for (let i = 0; i < count; i++) {
      const key = isrCacheKey('p', 'd', '/search', `https://h/search?q=${i}`);
      kv.set(key, new ArrayBuffer(4));
    }
  }

  it('writes a new variant when the path is under the cap', async () => {
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH - 1);
    const before = kvStore.size;

    await writeIsrCache(
      env,
      'p',
      'd',
      '/search',
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      'https://h/search?q=NEW',
    );

    expect(kvStore.size).toBe(before + 1);
    expect(kvStore.has(isrCacheKey('p', 'd', '/search', 'https://h/search?q=NEW'))).toBe(true);
  });

  it('refuses to write a brand-new variant once the cap is reached', async () => {
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH);
    const before = kvStore.size;

    await writeIsrCache(
      env,
      'p',
      'd',
      '/search',
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      'https://h/search?q=OVERFLOW',
    );

    // No new key written; existing kv state is untouched.
    expect(kvStore.size).toBe(before);
    expect(kvStore.has(isrCacheKey('p', 'd', '/search', 'https://h/search?q=OVERFLOW'))).toBe(
      false,
    );
  });

  it('still updates an existing variant past the cap (revalidation must keep working)', async () => {
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH);
    // Pick one of the seeded URLs to update.
    const updateUrl = 'https://h/search?q=5';
    const updateKey = isrCacheKey('p', 'd', '/search', updateUrl);
    expect(kvStore.has(updateKey)).toBe(true);
    const before = kvStore.size;
    const beforeBytes = kvStore.get(updateKey)!.byteLength;

    await writeIsrCache(
      env,
      'p',
      'd',
      '/search',
      new Response('<html>fresh</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      updateUrl,
    );

    // Same key, but value should be updated (different size — packed value
    // includes header JSON + body, both larger than the 4-byte seed).
    expect(kvStore.size).toBe(before);
    expect(kvStore.get(updateKey)!.byteLength).toBeGreaterThan(beforeBytes);
  });

  it('always writes direct-hit (non-variant) entries — cap only applies to #rw= entries', async () => {
    // Different pathnames each get their own cap; direct hits at one path
    // do not get squeezed by another path's variant fanout.
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH);
    const before = kvStore.size;

    await writeIsrCache(
      env,
      'p',
      'd',
      '/search',
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      undefined, // direct hit, no originalUrl
    );

    expect(kvStore.size).toBe(before + 1);
    expect(kvStore.has(isrCacheKey('p', 'd', '/search'))).toBe(true);
  });
});

describe('packIsrValue / unpackIsrValue', () => {
  it('round-trips headers and body', () => {
    const headers = { 'content-type': 'text/html', etag: '"abc"' };
    const body = new TextEncoder().encode('<html>hello</html>').buffer as ArrayBuffer;
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(headers);
    expect(new TextDecoder().decode(result!.body)).toBe('<html>hello</html>');
  });

  it('handles empty body', () => {
    const headers = { 'content-type': 'text/html' };
    const body = new ArrayBuffer(0);
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(headers);
    expect(result!.body.byteLength).toBe(0);
  });

  it('handles empty headers', () => {
    const headers = {};
    const body = new TextEncoder().encode('hello').buffer as ArrayBuffer;
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual({});
    expect(new TextDecoder().decode(result!.body)).toBe('hello');
  });

  it('returns null for buffer too small', () => {
    expect(unpackIsrValue(new ArrayBuffer(2))).toBeNull();
  });

  it('returns null for truncated header', () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, 999, true); // claims 999 bytes of headers
    expect(unpackIsrValue(buf)).toBeNull();
  });
});
