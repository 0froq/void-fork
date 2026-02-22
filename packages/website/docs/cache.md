# Caching and Headers

Vite Cloud serves static assets through Cloudflare's global edge network with sensible cache defaults. This page covers how static assets and dynamically rendered pages are cached, and how to customize response headers.

## Static asset caching

Every deploy generates a new version identifier. Static asset responses are cached at the edge using versioned cache keys, so new deploys instantly invalidate stale entries without purge APIs.

### Hashed assets

Files in Vite's `build.assetsDir` (default `assets/`) are produced with content hashes in the filename (e.g. `assets/app-Ab3xK9.js`). These are immutable — the filename changes whenever the content changes — so they get aggressive caching:

```
Cache-Control: public, max-age=31536000, immutable
```

Cached at the edge for up to one year. Browsers cache them indefinitely. Because the cache key is unversioned, hashed assets survive across deploys without re-fetching.

If your Vite config customizes `build.assetsDir`, Vite Cloud automatically detects this and applies the immutable optimization to the configured directory:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    assetsDir: "static", // hashed assets go to dist/client/static/
  },
});
```

If `build.assetsDir` is set to `""` (empty string — hashed files at the root), the optimization is skipped since there's no directory-based way to distinguish hashed from non-hashed files.

### Non-hashed assets

Everything else (`index.html`, `favicon.ico`, etc.) uses short edge caching with browser revalidation:

```
Cache-Control: public, s-maxage=60, max-age=0, must-revalidate
```

Cached at the edge for 60 seconds. Browsers always revalidate on the next request. Combined with versioned cache keys, this means new deploys are visible within seconds.

### ETags and 304 Not Modified

All static asset responses include an `ETag` header derived from the file's content hash in R2. When a browser revalidates a cached resource, it sends `If-None-Match` with the previous ETag. If the file hasn't changed, the edge returns a **304 Not Modified** with no body — saving bandwidth and speeding up page loads.

This happens automatically for all static assets. No configuration is needed.

### API routes

API responses (`/api/*`) and SSR-rendered pages that fall through to the worker are **not** edge-cached by the dispatch layer.

## Revalidation (ISR)

For SSR and [Pages mode](./pages-routing.md) projects, Vite Cloud supports stale-while-revalidate caching for dynamically rendered pages. Cached pages are served instantly from R2 while the worker re-renders in the background when the cache is stale. This is the equivalent of [Incremental Static Regeneration (ISR)](https://vercel.com/docs/incremental-static-regeneration) in other frameworks.

This requires [SSR](./ssr.md) or [Pages mode](./pages-routing.md) to be configured.

### Enabling revalidation

Add a `revalidate` field to `vite-cloud.json` with a TTL in seconds:

```json
{
  "revalidate": 60
}
```

Setting `revalidate` to `0` disables revalidation (equivalent to plain SSR).

### Per-path revalidation

You can set different TTLs for different URL patterns using an object:

```json
{
  "revalidate": {
    "/": 60,
    "/docs/*": 31536000,
    "/user/*": 0,
    "*": 30
  }
}
```

Rules are matched in order — first match wins. The `*` glob matches any characters including `/`.

Special values:

- `31536000` (1 year) — effectively cached until the next deploy (deploys clear the ISR cache)
- `0` — never cached, always rendered by the worker (equivalent to plain SSR for that path)

### Per-page revalidation (Pages mode)

In [Pages mode](./pages-routing.md), you can export a `revalidate` value from a `.server.ts` file to override the global config for that page:

```ts
// pages/products/index.server.ts
export const revalidate = 120; // cache for 2 minutes

export const loader = defineHandler(async (c) => {
  // ...
});
```

Per-page values take precedence over `vite-cloud.json` patterns.

### Precedence

When multiple sources set a revalidate TTL, the most specific wins:

1. `x-revalidate` response header (per-response)
2. `.server.ts` export (per-page, Pages mode only)
3. `vite-cloud.json` path pattern match
4. `vite-cloud.json` global number or `"*"` fallback

### How revalidation works

1. **First request** — no cache entry. The worker renders the page (blocking), the response is returned, and the result is written to R2 in the background.

2. **Subsequent requests (fresh)** — the cached response is served directly from R2. No worker call.

3. **Subsequent requests (stale)** — the stale cached response is served immediately, and the worker re-renders in the background. The next request gets the fresh version.

This means users never wait for a stale page to re-render — they always get an instant response.

### Per-response TTL override

Route handlers can set the `x-revalidate` response header to override the TTL for a specific response:

```ts
export const GET = defineHandler(async (c) => {
  // Don't cache this particular response
  c.header("x-revalidate", "0");

  return c.html("...");
});
```

- `x-revalidate: 0` — skip caching for this response
- `x-revalidate: 300` — cache for 5 minutes instead of the default

Only successful responses (2xx) are cached.

### Cache bypass

Requests with `Cookie` or `Authorization` headers bypass the ISR cache entirely and always dispatch to the worker. This ensures personalized or authenticated pages are never served from a shared cache.

### On-demand revalidation

You can purge ISR cache entries programmatically from a route handler:

```ts
import { revalidate } from "vite-cloud/isr";

export const POST = defineHandler(async (c) => {
  // ... update content in database ...

  // Purge specific pages
  await revalidate({ paths: ["/", "/blog/hello-world"] });

  // Or purge all cached pages
  await revalidate({ all: true });

  return c.json({ ok: true });
});
```

This requires two env bindings:

- `VITE_CLOUD_PROJECT_ID` — automatically injected by the platform on deploy
- `VITE_CLOUD_REVALIDATE_TOKEN` — set manually via `vcc secret set VITE_CLOUD_REVALIDATE_TOKEN <token>`

### Deploy behavior

Each deploy clears the ISR cache for the project. This ensures stale content from a previous deploy is never served. Hashed static assets are unaffected.

## Custom headers

Define custom response headers in [`vite-cloud.json`](./config.md) using the `headers` field. Keys are URL patterns, values are arrays of `"Name: value"` strings.

```json
{
  "headers": {
    "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"],
    "/*.html": ["Cache-Control: no-cache"]
  }
}
```

### Rules

- **Pattern keys** start with `/`. `*` matches any characters including `/`.
- **Header values** use `Name: value` format. The value may contain colons.
- All matching rules are merged. When multiple rules set the same header name, the **last match wins**.
- User-defined `Cache-Control` overrides the built-in default. The default still applies when no rule matches.

### Example: security headers

```json
{
  "headers": {
    "/*": [
      "X-Frame-Options: DENY",
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: strict-origin-when-cross-origin"
    ]
  }
}
```

### Example: override caching

```json
{
  "headers": {
    "/*.html": ["Cache-Control: public, max-age=300"],
    "/config.json": ["Cache-Control: no-store"]
  }
}
```

### Scope

Header rules apply to **static asset responses only** — files served from R2 (including SPA `index.html` fallbacks and SSG pages). They do not apply to:

- API route responses (`/api/*` dispatched to your worker)
- SSR-rendered responses (when a static asset is not found and the request falls through to your worker)

### How headers work

1. `vcc deploy` reads header rules from `vite-cloud.json` and includes them in the deploy manifest.
2. The platform stores the rules in the KV routing entry for your project.
3. The dispatch worker applies matching rules to static responses before edge caching.

Because rules are evaluated at the edge, there is no latency cost — headers are applied inline before the response is returned and cached.

## Request flow

1. `/api/*` requests go to worker API routes (not cached at the edge)
2. Static asset requests are served from R2 (hashed assets immutable, others versioned)
3. SSR `GET` requests without `Cookie`/`Authorization` (when `revalidate` is configured):
   - Cache hit (fresh) — served from R2
   - Cache hit (stale) — served from R2, worker re-renders in background
   - Cache miss — worker renders (blocking), cached in R2
4. All other requests dispatch to the worker directly
