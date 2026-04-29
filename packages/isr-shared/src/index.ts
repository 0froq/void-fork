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

/**
 * Build the normalized path segment for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
function normalizeIsrPath(pathname: string): string {
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
function canonicalIsrPathname(pathname: string): string {
  return denormalizeIsrPath(normalizeIsrPath(pathname));
}

/**
 * Prefix shared by every ISR key for a project at the current version —
 * `<projectId>/isr/v2/`. Used internally by `isrCachePrefix`.
 */
function isrCacheVersionPrefix(projectId: string): string {
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
 * Separator that marks the rewrite-variant suffix on an ISR cache key or
 * the corresponding edge-cache URL parameter. `#` cannot appear in
 * `url.pathname` (fragments are stripped before the request reaches the
 * server) and does not survive `normalizeIsrPath`, so it unambiguously
 * identifies the variant suffix.
 */
const ISR_VARIANT_SEPARATOR = '#rw=';

/**
 * Build the cache key for an ISR-cached page.
 * ISR is deployment-scoped so cached HTML cannot outlive the hashed assets
 * referenced by the deployment that produced it.
 *
 * When `originalUrl` is provided, the request was served via a dispatch-side
 * rewrite (`redirectRules`/`fallbackRules` with status 200). The original
 * request URL is mixed into the key so a direct hit to `/en/docs` and a
 * rewrite from `/docs` to `/en/docs` do not collide — user code can branch
 * on `c.isRewritten()` / `c.originalUrl()`, and the cache must honor that.
 * A missing `originalUrl` means "direct hit" and produces the legacy
 * rewriteless key (backward-compatible with entries written before this
 * feature landed).
 */
export function isrCacheKey(
  projectId: string,
  deploymentId: string,
  pathname: string,
  originalUrl?: string | null,
): string {
  const base = `${isrCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}`;
  if (!originalUrl) {
    return base;
  }
  return `${base}${ISR_VARIANT_SEPARATOR}${hashOriginalUrl(originalUrl)}`;
}

/**
 * Prefix used to list/purge every variant of a given pathname under a
 * deployment — both the direct-hit key and any rewrite-variant keys.
 */
export function isrCacheVariantPrefix(
  projectId: string,
  deploymentId: string,
  pathname: string,
): string {
  return `${isrCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}${ISR_VARIANT_SEPARATOR}`;
}

/**
 * Hash an original-URL value into a fixed-length, opaque variant token.
 * Used as both the KV-key suffix and the `__void_orig` query value, so the
 * writer and purger paths see byte-identical tokens for the same URL.
 *
 * Properties:
 *   - Sync (Workers `crypto.subtle.digest` is async; we don't want to push
 *     async through every read/write path for this).
 *   - 16 hex chars (64 bits) — bounds the KV key length regardless of input.
 *   - Non-recoverable: KV is operator-readable, and the previous base64url
 *     encoding let any operator with list access read the original URLs
 *     (including sensitive query strings like `?token=…`, `?email=…`).
 *   - Not cryptographic: collision resistance is ~2^32 (birthday). Fine for
 *     the per-deployment, per-pathname variant set we ever store in one slot.
 *
 * Implementation: FNV-1a 64-bit over UTF-8 bytes. BigInt arithmetic for the
 * multiply (no native u64 in JS), but inputs are short (URLs, sub-1KB) and
 * this only runs once per ISR-touched request.
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

export function hashOriginalUrl(originalUrl: string): string {
  const bytes = new TextEncoder().encode(originalUrl);
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i]!)) & FNV_MASK;
    h = (h * FNV_PRIME) & FNV_MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Split a fully-qualified ISR KV key into the normalized pathname segment
 * and the optional rewrite-variant token. Returns `null` token when the
 * key has no `#rw=` suffix (direct hit).
 *
 * The token is opaque (a hash); the original URL it was derived from is not
 * recoverable. Callers that need to reproduce the matching edge-cache URL
 * pass the token through `isrEdgeCacheUrlForToken`.
 */
export function splitIsrCacheKey(fullKey: string): {
  normalizedPath: string;
  variantToken: string | null;
} {
  const sepIdx = fullKey.indexOf(ISR_VARIANT_SEPARATOR);
  if (sepIdx === -1) {
    return { normalizedPath: fullKey, variantToken: null };
  }
  return {
    normalizedPath: fullKey.slice(0, sepIdx),
    variantToken: fullKey.slice(sepIdx + ISR_VARIANT_SEPARATOR.length),
  };
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
  originalUrl?: string | null,
): string {
  return buildIsrEdgeCacheUrl(
    hostname,
    pathname,
    deploymentId,
    variant,
    originalUrl ? hashOriginalUrl(originalUrl) : null,
  );
}

/**
 * Like `isrEdgeCacheUrl`, but takes a pre-hashed variant token (from
 * `splitIsrCacheKey`). Used by the purger, which only knows the hashed
 * token: the original URL is not recoverable from a KV key.
 */
export function isrEdgeCacheUrlForToken(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  variantToken?: string | null,
): string {
  return buildIsrEdgeCacheUrl(hostname, pathname, deploymentId, variant, variantToken ?? null);
}

function buildIsrEdgeCacheUrl(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  variantToken: string | null,
): string {
  const normalizedPathname = canonicalIsrPathname(pathname);
  const url = new URL(`https://${hostname}${normalizedPathname}`);
  if (variant === 'json') {
    url.searchParams.set('__void', 'json');
  }
  url.searchParams.set('__void_isr', deploymentId);
  if (variantToken) {
    url.searchParams.set('__void_orig', variantToken);
  }
  return url.toString();
}
