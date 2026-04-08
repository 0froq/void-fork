import type { Env } from './env';
import { matchPattern } from './headers';

export interface IsrCacheEntry {
  body: ReadableStream;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  ttl: number;
}

export interface IsrCacheMetadata {
  /** HTTP status code */
  s: number;
  /** createdAt (ms) */
  c: number;
  /** TTL (seconds) */
  t: number;
}

const PAGE_DATA_SCRIPT_RE =
  /<script\b[^>]*\bid=(["'])__VOID_PAGE_DATA__\1[^>]*>([\s\S]*?)<\/script>/i;

/**
 * Pack response headers + body into a single ArrayBuffer.
 * Format: [4 bytes uint32 LE header length][UTF-8 header JSON][raw body]
 */
export function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true); // little-endian
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/**
 * Unpack headers + body from a packed ArrayBuffer.
 * Returns null if the buffer is too small or malformed.
 */
export function unpackIsrValue(
  buffer: ArrayBuffer,
): { headers: Record<string, string>; body: ArrayBuffer } | null {
  if (buffer.byteLength < 4) {
    return null;
  }
  const view = new DataView(buffer);
  const headerLen = view.getUint32(0, true);
  if (buffer.byteLength < 4 + headerLen) {
    return null;
  }
  try {
    const headerBytes = new Uint8Array(buffer, 4, headerLen);
    const headers: Record<string, string> = JSON.parse(new TextDecoder().decode(headerBytes));
    const body = buffer.slice(4 + headerLen);
    return { headers, body };
  } catch {
    return null;
  }
}

/**
 * Build the cache key for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
export function isrCacheKey(projectId: string, pathname: string): string {
  let normalized = pathname;
  if (normalized === '/') {
    normalized = '__index__';
  } else {
    // Strip leading slash
    normalized = normalized.startsWith('/') ? normalized.slice(1) : normalized;
    // Strip trailing slash
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
  }
  return `${projectId}/isr/${normalized}`;
}

/**
 * Read an ISR cache entry from KV.
 * Returns null on cache miss or if metadata is malformed.
 */
export async function readIsrCache(
  env: Env,
  projectId: string,
  pathname: string,
): Promise<IsrCacheEntry | null> {
  const key = isrCacheKey(projectId, pathname);
  const { value, metadata } = await env.ISR_CACHE.getWithMetadata<IsrCacheMetadata>(
    key,
    'arrayBuffer',
  );
  if (!value || !metadata) {
    return null;
  }

  const unpacked = unpackIsrValue(value);
  if (!unpacked) {
    return null;
  }

  if (!metadata.c || !metadata.t) {
    return null;
  }

  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(unpacked.body));
        controller.close();
      },
    }),
    status: metadata.s,
    headers: unpacked.headers,
    createdAt: metadata.c,
    ttl: metadata.t,
  };
}

/**
 * Delete an ISR cache entry from KV.
 * Used when a worker permanently opts out via x-revalidate: 0.
 */
export async function deleteIsrCache(env: Env, projectId: string, pathname: string): Promise<void> {
  const key = isrCacheKey(projectId, pathname);
  await env.ISR_CACHE.delete(key);
}

/**
 * Write an ISR cache entry to KV.
 */
export async function writeIsrCache(
  env: Env,
  projectId: string,
  pathname: string,
  response: Response,
  ttl: number,
): Promise<void> {
  const key = isrCacheKey(projectId, pathname);
  const headers = serializeHeaders(response);
  const body = await response.clone().arrayBuffer();
  const packed = packIsrValue(headers, body);

  await env.ISR_CACHE.put(key, packed, {
    metadata: {
      s: response.status,
      c: Date.now(),
      t: ttl,
    } satisfies IsrCacheMetadata,
  });
}

/**
 * Check if a cached entry is stale.
 */
export function isStale(entry: IsrCacheEntry): boolean {
  return Date.now() - entry.createdAt > entry.ttl * 1000;
}

/**
 * Build a Response from an ISR cache entry.
 */
export function isrCacheResponse(entry: IsrCacheEntry, stale: boolean): Response {
  const headers = new Headers(entry.headers);
  headers.set('x-isr-cache', stale ? 'STALE' : 'HIT');

  // Edge-cacheable: s-maxage controls CDN TTL based on remaining ISR freshness.
  // Browser always revalidates (max-age=0) so users see updates after edge expiry.
  if (stale) {
    // Stale: short edge TTL while background revalidation runs.
    // Cap at entry.ttl so short-TTL configs don't serve stale longer than their ISR window.
    const staleTtl = Math.min(10, entry.ttl);
    headers.set('Cache-Control', `public, s-maxage=${staleTtl}, max-age=0, must-revalidate`);
  } else {
    const remainingSeconds = Math.max(
      0,
      Math.floor((entry.createdAt + entry.ttl * 1000 - Date.now()) / 1000),
    );
    headers.set(
      'Cache-Control',
      `public, s-maxage=${remainingSeconds}, max-age=0, must-revalidate`,
    );
  }

  return new Response(entry.body, {
    status: entry.status,
    headers,
  });
}

/**
 * Read the `x-revalidate` header from a worker response.
 * Returns the override TTL, or null to use the default.
 * A value of 0 means "do not cache this response".
 */
export function resolveRevalidateTtl(response: Response, defaultTtl: number): number {
  const header = response.headers.get('x-revalidate');
  if (header === null) {
    return defaultTtl;
  }

  const value = parseInt(header, 10);
  if (isNaN(value) || value < 0) {
    return defaultTtl;
  }
  return value;
}

/**
 * ISR should be bypassed for requests with credentials.
 * Pages protocol navigation (X-VoidPages) now uses a separate JSON edge cache.
 */
export function shouldBypassIsr(request: Request): boolean {
  return request.headers.has('Cookie') || request.headers.has('Authorization');
}

/**
 * Resolve the ISR TTL for a given pathname.
 * Accepts the `revalidate` config from the routing entry (number, object, or undefined).
 * For object form, first matching pattern wins.
 */
export function resolvePathTtl(
  revalidate: number | Record<string, number> | undefined,
  pathname: string,
): number {
  if (revalidate == null) {
    return 0;
  }
  if (typeof revalidate === 'number') {
    return revalidate;
  }
  for (const [pattern, ttl] of Object.entries(revalidate)) {
    if (matchPattern(pattern, pathname)) {
      return ttl;
    }
  }
  return 0;
}

export function normalizePageDataForJsonCache(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { deferred?: unknown; deferredKeys?: unknown };
    if (parsed.deferred !== undefined || parsed.deferredKeys !== undefined) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function extractPageDataFromHtml(html: string): string | null {
  const match = html.match(PAGE_DATA_SCRIPT_RE);
  if (!match) {
    return null;
  }
  return normalizePageDataForJsonCache(match[2]);
}

/**
 * Extract response headers as a plain object, skipping ISR-managed headers.
 */
const SKIP_HEADERS = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

export function serializeHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}

/**
 * Build a normalized cache key Request for the edge cache (caches.default).
 * Uses origin + pathname only (no query params) to match cache key behavior.
 */
export function isrEdgeCacheKey(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  return new Request(`${url.origin}${pathname}`, { method: 'GET' });
}

/**
 * Build an edge cache key for the JSON variant (pages protocol navigation).
 * Uses `?__void=json` suffix to separate from the HTML edge cache.
 */
export function isrEdgeCacheKeyJson(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  return new Request(`${url.origin}${pathname}?__void=json`, { method: 'GET' });
}
