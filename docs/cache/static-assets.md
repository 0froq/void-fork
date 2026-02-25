---
outline: deep
---

# Static Asset Caching

Void serves static assets through Cloudflare's global edge network with sensible cache defaults. This page covers how static assets are cached at the edge.

## Hashed assets

Files in Vite's `build.assetsDir` (default `assets/`) are produced with content hashes in the filename (e.g. `assets/app-Ab3xK9.js`). These are immutable — the filename changes whenever the content changes — so they get aggressive caching:

```
Cache-Control: public, max-age=31536000, immutable
```

Cached at the edge for up to one year. Browsers cache them indefinitely. Because the cache key is unversioned, hashed assets survive across deploys without re-fetching.

If your Vite config customizes `build.assetsDir`, Void automatically detects this and applies the immutable optimization to the configured directory:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    assetsDir: "static", // hashed assets go to dist/client/static/
  },
});
```

If `build.assetsDir` is set to `""` (empty string — hashed files at the root), the optimization is skipped since there's no directory-based way to distinguish hashed from non-hashed files.

## Non-hashed assets

Everything else (`index.html`, `favicon.ico`, etc.) uses short edge caching with browser revalidation:

```
Cache-Control: public, s-maxage=60, max-age=0, must-revalidate
```

Cached at the edge for 60 seconds. Browsers always revalidate on the next request. Combined with versioned cache keys, this means new deploys are visible within seconds.

## ETags and 304 Not Modified

All static asset responses include an `ETag` header derived from the file's content hash in R2. When a browser revalidates a cached resource, it sends `If-None-Match` with the previous ETag. If the file hasn't changed, the edge returns a **304 Not Modified** with no body — saving bandwidth and speeding up page loads.

This happens automatically for all static assets. No configuration is needed.

## API routes

API responses (`/api/*`) and SSR-rendered pages that fall through to the worker are **not** edge-cached by the dispatch layer.

## Request flow

1. `/api/*` requests go to worker API routes (not cached at the edge)
2. Static asset requests are served from R2 (hashed assets immutable, others versioned)
3. SSR `GET` requests without `Cookie`/`Authorization` (when `cache.revalidate` is configured):
   - Cache hit (fresh) — served from R2
   - Cache hit (stale) — served from R2, worker re-renders in background
   - Cache miss — worker renders (blocking), cached in R2
4. All other requests dispatch to the worker directly
