/**
 * Shared ISR key/URL helpers used by both the API (purge) and the dispatch
 * worker (read/write). These functions MUST produce byte-identical output:
 * the API purges KV keys and edge URLs that dispatch writes and reads.
 *
 * Dispatch derives the deployment id for its keys via
 * `routing.version ?? 'legacy'`, which allows any non-nullish value —
 * including the empty string — to pass through unchanged. The helpers below
 * preserve that shape so the API can compute the exact same key for purge.
 */

const ISR_CACHE_KEY_VERSION = 'v2';

export { ISR_CACHE_KEY_VERSION };

/**
 * Build the normalized path segment for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
export function normalizeIsrPath(pathname: string): string {
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
  return normalized;
}

/**
 * Inverse of `normalizeIsrPath`: turn a normalized segment back into a
 * pathname starting with `/`.
 */
export function denormalizeIsrPath(normalized: string): string {
  return normalized === '__index__' ? '/' : `/${normalized}`;
}

/**
 * Canonicalize an inbound pathname to the form used inside edge cache URLs.
 * Equivalent to `denormalizeIsrPath(normalizeIsrPath(pathname))` — strips any
 * trailing slash except for root.
 */
export function canonicalIsrPathname(pathname: string): string {
  return denormalizeIsrPath(normalizeIsrPath(pathname));
}

/**
 * Prefix shared by every ISR key for a project at the current version —
 * `<projectId>/isr/v2/`. Used internally by `isrCachePrefix`.
 */
export function isrCacheVersionPrefix(projectId: string): string {
  return `${projectId}/isr/${ISR_CACHE_KEY_VERSION}/`;
}

/**
 * Prefix for listing/purging ISR keys.
 *
 * `deploymentId === ''` must still produce the versioned prefix with an
 * empty segment (`<projectId>/isr/v2//`) because dispatch uses
 * `routing.version ?? 'legacy'`, which allows empty strings and writes
 * keys at `<projectId>/isr/v2//<path>`. Only `undefined` selects the
 * legacy scan-all prefix (`<projectId>/isr/`).
 */
export function isrCachePrefix(projectId: string, deploymentId?: string): string {
  if (deploymentId !== undefined) {
    return `${isrCacheVersionPrefix(projectId)}${deploymentId}/`;
  }
  return `${projectId}/isr/`;
}

/**
 * Build the cache key for an ISR-cached page.
 * ISR is deployment-scoped so cached HTML cannot outlive the hashed assets
 * referenced by the deployment that produced it.
 */
export function isrCacheKey(projectId: string, deploymentId: string, pathname: string): string {
  return `${isrCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}`;
}

/**
 * Build the edge cache URL that dispatch uses as its `caches.default` key
 * (wrapped in a GET `Request`). The public URL stays clean; the internal
 * cache key carries the deployment id so a new deploy never reads HTML
 * produced by an older deploy. The `json` variant separates pages-protocol
 * JSON responses from HTML for the same path+deployment.
 *
 * This MUST match the URL dispatch writes. Dispatch builds the URL from
 * `new URL(request.url).hostname`; for standard-port HTTPS traffic (all CF
 * edge traffic) that yields the same origin as the one produced here.
 */
export function isrEdgeCacheUrl(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
): string {
  const normalizedPathname = canonicalIsrPathname(pathname);
  const url = new URL(`https://${hostname}${normalizedPathname}`);
  if (variant === 'json') {
    url.searchParams.set('__void', 'json');
  }
  url.searchParams.set('__void_isr', deploymentId);
  return url.toString();
}
