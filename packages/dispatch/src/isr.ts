import type { Env } from "./env";
import { matchPattern } from "./headers";

export interface IsrCacheEntry {
  body: ReadableStream;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  ttl: number;
}

/**
 * Build the R2 key for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
export function isrR2Key(projectId: string, pathname: string): string {
  let normalized = pathname;
  if (normalized === "/") {
    normalized = "__index__";
  } else {
    // Strip leading slash
    normalized = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    // Strip trailing slash
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
  }
  return `${projectId}/isr/${normalized}`;
}

/**
 * Read an ISR cache entry from R2.
 * Returns null on cache miss or if metadata is malformed.
 */
export async function readIsrCache(
  env: Env,
  projectId: string,
  pathname: string,
): Promise<IsrCacheEntry | null> {
  const key = isrR2Key(projectId, pathname);
  const object = await env.ASSETS.get(key);
  if (!object) return null;

  const meta = object.customMetadata ?? {};
  const status = parseInt(meta.status ?? "200", 10);
  const createdAt = parseInt(meta.createdAt ?? "0", 10);
  const ttl = parseInt(meta.ttl ?? "0", 10);

  if (!createdAt || !ttl) return null;

  let headers: Record<string, string> = {};
  try {
    headers = meta.headers ? JSON.parse(meta.headers) : {};
  } catch {
    // Malformed headers metadata — treat as empty
  }

  return {
    body: object.body,
    status,
    headers,
    createdAt,
    ttl,
  };
}

/**
 * Delete an ISR cache entry from R2.
 * Used when a worker permanently opts out via x-revalidate: 0.
 */
export async function deleteIsrCache(env: Env, projectId: string, pathname: string): Promise<void> {
  const key = isrR2Key(projectId, pathname);
  await env.ASSETS.delete(key);
}

/**
 * Write an ISR cache entry to R2.
 */
export async function writeIsrCache(
  env: Env,
  projectId: string,
  pathname: string,
  response: Response,
  ttl: number,
): Promise<void> {
  const key = isrR2Key(projectId, pathname);
  const headers = serializeHeaders(response);

  await env.ASSETS.put(key, response.clone().body!, {
    customMetadata: {
      status: String(response.status),
      createdAt: String(Date.now()),
      ttl: String(ttl),
      headers: JSON.stringify(headers),
    },
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
  headers.set("x-isr-cache", stale ? "STALE" : "HIT");

  // Edge-cacheable: s-maxage controls CDN TTL based on remaining ISR freshness.
  // Browser always revalidates (max-age=0) so users see updates after edge expiry.
  if (stale) {
    // Stale: short edge TTL while background revalidation runs.
    // Cap at entry.ttl so short-TTL configs don't serve stale longer than their ISR window.
    const staleTtl = Math.min(10, entry.ttl);
    headers.set("Cache-Control", `public, s-maxage=${staleTtl}, max-age=0, must-revalidate`);
  } else {
    const remainingSeconds = Math.max(
      0,
      Math.floor((entry.createdAt + entry.ttl * 1000 - Date.now()) / 1000),
    );
    headers.set(
      "Cache-Control",
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
  const header = response.headers.get("x-revalidate");
  if (header === null) return defaultTtl;

  const value = parseInt(header, 10);
  if (isNaN(value) || value < 0) return defaultTtl;
  return value;
}

/**
 * ISR should be bypassed for requests with credentials.
 */
export function shouldBypassIsr(request: Request): boolean {
  return request.headers.has("Cookie") || request.headers.has("Authorization");
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
  if (revalidate == null) return 0;
  if (typeof revalidate === "number") return revalidate;
  for (const [pattern, ttl] of Object.entries(revalidate)) {
    if (matchPattern(pattern, pathname)) return ttl;
  }
  return 0;
}

/**
 * Extract response headers as a plain object, skipping ISR-managed headers.
 */
function serializeHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  const skip = new Set(["cache-control", "x-isr-cache"]);

  response.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}
