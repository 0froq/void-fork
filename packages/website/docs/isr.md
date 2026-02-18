# ISR (Incremental Static Regeneration)

ISR adds stale-while-revalidate caching for SSR pages. Cached pages are served instantly from R2 while the worker re-renders in the background when the cache is stale.

This requires [SSR](./ssr.md) to be configured.

## Enabling ISR

Export a `revalidate` number (in seconds) from `src/main.ssr.ts(x)`:

```ts
export const revalidate = 60; // cache pages for 60 seconds

export default defineRender(async (c, assetTags) => {
  // ...
});
```

Setting `revalidate` to `0` disables ISR (equivalent to plain SSR).

## How it works

1. **First request** — no cache entry. The worker renders the page (blocking), the response is returned, and the result is written to R2 in the background.

2. **Subsequent requests (fresh)** — the cached response is served directly from R2. No worker call.

3. **Subsequent requests (stale)** — the stale cached response is served immediately, and the worker re-renders in the background. The next request gets the fresh version.

This means users never wait for a stale page to re-render — they always get an instant response.

## Per-response TTL override

The `defineRender` callback can set the `x-revalidate` response header to override the default TTL for specific pages:

```ts
export const revalidate = 60;

export default defineRender(async (c, assetTags) => {
  const url = new URL(c.req.raw.url);

  // Don't cache the user profile page (always SSR)
  if (url.pathname.startsWith("/profile")) {
    c.header("x-revalidate", "0");
  }

  // Cache the homepage longer
  if (url.pathname === "/") {
    c.header("x-revalidate", "300");
  }

  const html = renderToString(<App url={url.pathname} />);
  return new Response(`<!doctype html><html>...</html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
```

- `x-revalidate: 0` — skip caching for this response
- `x-revalidate: 300` — cache for 5 minutes instead of the default 60s

Only successful responses (2xx) are cached.

## ISR bypass

Requests with `Cookie` or `Authorization` headers bypass the ISR cache entirely and always dispatch to the worker. This ensures personalized or authenticated pages are never served from a shared cache.

## On-demand revalidation

You can purge ISR cache entries programmatically from a route handler:

```ts
import { revalidate } from "vite-cloud/isr";

export const POST = defineHandler(async (c) => {
  // ... update content in database ...

  // Purge specific pages
  await revalidate({ paths: ["/", "/blog/hello-world"] });

  // Or purge all ISR-cached pages
  await revalidate({ all: true });

  return c.json({ ok: true });
});
```

This requires two env bindings:

- `VITE_CLOUD_PROJECT_ID` — automatically injected by the platform on deploy
- `VITE_CLOUD_REVALIDATE_TOKEN` — set manually via `vcd secret set VITE_CLOUD_REVALIDATE_TOKEN <token>`

## Deploy behavior

Each deploy clears the ISR cache for the project. This ensures stale content from a previous deploy is never served.

## Request flow

With ISR enabled:

1. `/api/*` requests go to worker API routes (not cached)
2. Static asset hits (JS, CSS, images) are served from R2
3. `GET` requests without `Cookie`/`Authorization`:
   - ISR cache hit (fresh) — served from R2
   - ISR cache hit (stale) — served from R2, worker re-renders in background
   - ISR cache miss — worker renders (blocking), cached in R2
4. All other requests fall through to the worker directly
