# @voidcloud/isr-shared

Shared cache-key and edge-cache URL contract for ISR (Incremental Static Regeneration) between the API control plane (the purger) and the dispatch edge worker (the writer/reader).

**Consumers:** `packages/dispatch` (writes/reads the ISR slot) and `packages/api` (purges on revalidation) are the only intended consumers. This is an internal platform package — not a general-purpose ISR utility — and is not published or supported for use outside the monorepo. See "Who Imports This" below for the specific call sites.

## Purpose

When a request is served via a dispatch-side rewrite (`routing.rewrites` or `routing.fallbacks`), the ISR slot splits per original-request URL via the `#rw=` variant suffix — so user code that branches on `c.isRewritten()` / `c.originalUrl()` doesn't share a cache entry with the direct-hit path to the same destination.

ISR cache entries are written by `packages/dispatch` and purged by `packages/api`. The two workers must produce byte-identical keys and URLs — if the purger and the writer disagree on a single character, purges silently miss and stale HTML survives revalidation. This package centralizes every helper that constructs an ISR KV key or an edge-cache URL so the two sides cannot drift.

Any new helper that touches the key or URL format belongs here, not in `api/` or `dispatch/`. Duplication is the failure mode this package exists to prevent.

## Public API

| Symbol                    | Description                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `isrCacheKey`             | Build a full ISR KV key, optionally including a rewrite-variant suffix derived from the original request URL.            |
| `isrCachePrefix`          | Prefix for listing/purging ISR keys by deployment (or all deployments when `deploymentId` is `undefined`).               |
| `isrCacheVariantPrefix`   | Prefix that matches every rewrite variant of a given pathname under a deployment (for listing/purging).                  |
| `splitIsrCacheKey`        | Split a full key into `{ normalizedPath, variantToken }` — `variantToken` is `null` for direct-hit (non-rewrite) keys.   |
| `denormalizeIsrPath`      | Turn a normalized path segment back into a pathname starting with `/`. Paired with `splitIsrCacheKey` on purge.          |
| `isrEdgeCacheUrl`         | Build the internal edge-cache URL used as the `caches.default` key. Takes the original URL; hashes it internally.        |
| `isrEdgeCacheUrlForToken` | Same shape, but takes a pre-hashed variant token (the form returned by `splitIsrCacheKey`). Used by the purge path.      |
| `hashOriginalUrl`         | Sync FNV-1a 64-bit hex hash of the original URL. Exposed for callers that need to compute the token outside the helpers. |

Path normalization (`normalizeIsrPath` / `canonicalIsrPathname`), the version prefix (`isrCacheVersionPrefix`), and the version constant (`ISR_CACHE_KEY_VERSION`) are package-internal. Consumers work through the key-building helpers above so the format contract lives in one place; add a new exported helper rather than reaching for an internal if a call site needs one.

## Key Format

```
<projectId>/isr/v2/<deploymentId>/<normalizedPath>[#rw=<variantTokenHex>]
```

- `<projectId>/isr/v2/` — namespacing plus the current format version. The version prefix exists so a format change can coexist with stale entries from the previous version; bump `ISR_CACHE_KEY_VERSION` rather than reusing the current prefix. The current `v2` bump specifically lets pre-rewrite entries (written under the older `v1`-equivalent layout, before the rewrite-variant suffix shipped) age out alongside post-rewrite `v2` entries during the rollout — readers and writers on the new version don't collide with the old ones. A future incompatible change would bump to `v3` rather than overwrite `v2`; do not remove the version prefix as "dead weight" — that silently breaks cache compatibility the next time the format evolves.
- `<deploymentId>` — scopes each entry to the deployment that produced it. Cached HTML embeds hashed asset URLs from a specific deployment; reading it after a new deploy ships would serve stale HTML pointing at assets that no longer exist. Scoping by deployment makes that structurally impossible.
- `<normalizedPath>` — the pathname passed through `normalizeIsrPath`. Root `/` becomes `__index__`; other paths have leading and trailing slashes stripped.
- `#rw=<token>` — optional rewrite-variant suffix. When a request was served via a dispatch-phase rewrite (`routing.rewrites`, `routing.fallbacks`, or a `_redirects` `200`/`200!` entry), the ISR slot splits per original request URL so direct hits and rewrite-served hits do not share cache entries (user code can branch on `c.isRewritten()` / `c.originalUrl()`). `#` is used as the separator because it cannot appear inside `url.pathname` — the browser strips fragments before the request reaches the edge — and it never survives `normalizeIsrPath`, so the suffix is unambiguous.

## Variant Tokens

Variant tokens are a fixed-length hex hash (FNV-1a 64-bit, 16 chars) of the UTF-8 bytes of the original request URL. The same hash is used as the KV-key suffix and as the `__void_orig=<token>` query value on the internal edge-cache URL, so the writer (dispatch) and the purger (api) compute byte-identical tokens for the same URL.

Hashing — rather than reversibly encoding the URL — is deliberate:

- **KV is operator-readable.** A reversible token (the prior `btoa` encoding) let any operator with KV list access read the original URLs, including sensitive query strings (`?token=…`, `?email=…`).
- **Variant tokens are KV-key suffixes.** A fixed-length hash bounds the total key size regardless of how long the original URL was, so KV's name-length limit can't be approached by any single request.

The hash is sync (BigInt FNV-1a; Workers' `crypto.subtle.digest` is async and we don't want to push async through every read/write). Collision resistance is ~2^32 (birthday) — fine for the per-deployment, per-pathname variant set we ever store; the per-pathname variant cap (see `isr` issue #6) keeps that population well under the threshold.

Because the original URL is not recoverable from a variant token, `splitIsrCacheKey` returns the token directly (as `variantToken`), and the purger calls `isrEdgeCacheUrlForToken` rather than re-hashing.

## Who Imports This

- `packages/api/src/isr-cache.ts` — purge path (`POST /projects/:id/revalidate` and the proxy-forwarded equivalent). Uses `splitIsrCacheKey` to decode variant KV entries and `isrEdgeCacheUrl` to reconstruct the matching edge-cache URL.
- `packages/dispatch/src/isr.ts` — read/write path. Uses `isrCacheKey` and `isrEdgeCacheUrl` to resolve the slot for every ISR-backed page request.

## Rules for Adding Helpers

1. Any new helper that touches ISR key or URL format MUST live in this package. Do not inline a new format in `api/` or `dispatch/`.
2. Any incompatible change to the format (different prefix, different separators, different encoding) requires bumping `ISR_CACHE_KEY_VERSION`. Writers after the bump must produce keys under the new version; the old keys expire naturally as their deployments age out. Do not reuse a version number.
3. Additive changes that extend an existing key suffix (new query parameters on the edge URL, new optional suffix segments on the KV key) are safe without a version bump as long as readers at both versions treat the absence of the new component as the previous default.
