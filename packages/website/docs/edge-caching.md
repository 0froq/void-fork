# Edge Caching

Edge caching adds stale-while-revalidate caching for SSR pages. Cached pages are served instantly from R2 while the worker re-renders in the background when the cache is stale. This is the equivalent of [Incremental Static Regeneration (ISR)](https://vercel.com/docs/incremental-static-regeneration) in other frameworks.

This requires [SSR](./ssr.md) or [Pages mode](./pages-routing.md) to be configured.

## Enabling edge caching

Add a `revalidate` field to `vite-cloud.json` with a TTL in seconds:

```json
{
  "revalidate": 60
}
```

Setting `revalidate` to `0` disables edge caching (equivalent to plain SSR).

## Per-path revalidation

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

- `31536000` (1 year) — effectively cached until the next deploy (deploys clear the edge cache)
- `0` — never cached, always rendered by the worker (equivalent to plain SSR for that path)

## Per-page revalidation (Pages mode)

In [Pages mode](./pages-routing.md), you can export a `revalidate` value from a `.server.ts` file to override the global config for that page:

```ts
// pages/products/index.server.ts
export const revalidate = 120; // cache for 2 minutes

export const loader = defineHandler(async (c) => {
  // ...
});
```

Per-page values take precedence over `vite-cloud.json` patterns.

## Precedence

When multiple sources set a revalidate TTL, the most specific wins:

1. `x-revalidate` response header (per-response)
2. `.server.ts` export (per-page, Pages mode only)
3. `vite-cloud.json` path pattern match
4. `vite-cloud.json` global number or `"*"` fallback

## How it works

1. **First request** — no cache entry. The worker renders the page (blocking), the response is returned, and the result is written to R2 in the background.

2. **Subsequent requests (fresh)** — the cached response is served directly from R2. No worker call.

3. **Subsequent requests (stale)** — the stale cached response is served immediately, and the worker re-renders in the background. The next request gets the fresh version.

This means users never wait for a stale page to re-render — they always get an instant response.

## Per-response TTL override

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

## Cache bypass

Requests with `Cookie` or `Authorization` headers bypass the edge cache entirely and always dispatch to the worker. This ensures personalized or authenticated pages are never served from a shared cache.

## On-demand revalidation

You can purge edge cache entries programmatically from a route handler:

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

## Deploy behavior

Each deploy clears the edge cache for the project. This ensures stale content from a previous deploy is never served.

## Request flow

With edge caching enabled:

1. `/api/*` requests go to worker API routes (not cached)
2. Static asset hits (JS, CSS, images) are served from R2
3. `GET` requests without `Cookie`/`Authorization`:
   - Cache hit (fresh) — served from R2
   - Cache hit (stale) — served from R2, worker re-renders in background
   - Cache miss — worker renders (blocking), cached in R2
4. All other requests fall through to the worker directly
