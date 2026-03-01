# Dispatch-Level Hashed Asset Caching

**Date:** 2026-03-01
**Status:** Proposed

---

## Summary

Move edge caching of hashed static assets from the user worker (`serveWithAssets`) to the dispatch worker. Dispatch already performs a KV lookup on every request — adding a path prefix check is essentially free. On cache hit, the user worker is never invoked, eliminating WfP invocation cost for the most common static asset requests.

---

## Problem

With `run_worker_first: ["/**"]`, every request — including static assets — invokes the user worker via Workers for Platforms. The `serveWithAssets` helper checks the Cache API inside the user worker, but the worker is still invoked on every request. For hashed assets (JS bundles, CSS, images with content hashes), the content never changes, yet we pay WfP invocation cost every time.

---

## Design

### Scope: hashed assets only

Only assets under the hashed prefix (`/{hashedAssetsPrefix}/`) are cached at dispatch. These have content-hash URLs that change on every build, so immutable caching is safe with no invalidation needed.

Non-hashed assets (`favicon.ico`, `robots.txt`, `public/` files) continue through the user worker. Dispatch can't distinguish these from app routes without an R2 lookup, which would add latency to every request. These are low-volume and not worth optimizing.

### Request flow

```
Request → Dispatch
  → KV lookup (already happens) → get hashedAssetsPrefix
  → GET request + path starts with /{hashedAssetsPrefix}/?
    → YES:
      → caches.default.match(request)
      → HIT: return cached response (user worker never invoked)
      → MISS: invoke user worker → get response
        → set Cache-Control: public, max-age=31536000, immutable
        → ctx.waitUntil(cache.put(request, response.clone()))
        → return response
    → NO: normal flow (invoke user worker)
```

### Data flow: `hashedAssetsPrefix` through the pipeline

```
Framework preset / void.json → DeployManifest → API → KV RoutingEntry → Dispatch
```

The hashed assets prefix varies by framework:

| Framework      | `hashedAssetsPrefix`    |
| -------------- | ----------------------- |
| Void (Class A) | `assets` (Vite default) |
| SvelteKit      | `_app/immutable`        |
| Nuxt           | `_nuxt`                 |
| Astro          | `_astro`                |

---

## Changes

### 1. `DeployManifest` (framework)

Add optional field:

```typescript
export interface DeployManifest {
  // ... existing fields ...
  hashedAssetsPrefix?: string;
}
```

### 2. Deploy CLI (framework)

Set `hashedAssetsPrefix` from framework preset (`hashedAssetsPrefix` field) or Vite config (`build.assetsDir`, default `"assets"`).

### 3. API deploy endpoint

Read `hashedAssetsPrefix` from the manifest and include it in the KV routing entry written during deploy.

### 4. `RoutingEntry` (dispatch)

Add optional field:

```typescript
interface RoutingEntry {
  // ... existing fields ...
  hashedAssetsPrefix?: string;
}
```

### 5. Dispatch `fetch()`

Before routing to the user worker, check if the request is a GET for a hashed asset:

```typescript
if (request.method === "GET" && routing.hashedAssetsPrefix) {
  const prefix = "/" + routing.hashedAssetsPrefix + "/";
  if (url.pathname.startsWith(prefix)) {
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;
    // Cache miss — invoke worker, cache response
    const response = await worker.fetch(request);
    if (response.ok) {
      const res = new Response(response.body, response);
      res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    }
    return response;
  }
}
```

### 6. `serveWithAssets` (framework)

Revert to simple version — set `Cache-Control` headers on asset responses (for browser caching) but remove programmatic Cache API usage. The edge caching now happens at dispatch.

```javascript
async function serveWithAssets(request, env, response) {
  if (response.status !== 404 || !env.ASSETS) return response;
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return response;
  const res = new Response(asset.body, asset);
  if (new URL(request.url).pathname.startsWith("/{assetsDir}/")) {
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.headers.set("Cache-Control", "public, s-maxage=60, max-age=0, must-revalidate");
  }
  return res;
}
```

---

## What stays the same

- **ISR** — untouched, separate L1/L2 cache in dispatch
- **Non-hashed assets** — served by user worker via ASSETS binding
- **Metering** — dispatch still records the request before the cache check returns
- **`_headers` generation** — kept for direct wrangler deploys
- **Cache invalidation** — not needed; hashed URLs change on content change
- **Node/Bun/Deno targets** — don't use `serveWithAssets` or dispatch

---

## Edge cases

- **No `hashedAssetsPrefix` in KV** — old deploys without the field: dispatch skips the optimization, falls through to user worker. Fully backward-compatible.
- **Cache eviction** — CF edge caches evict based on popularity. Low-traffic assets get evicted → cache miss → user worker → re-cache. Fine.
- **HEAD/OPTIONS requests** — only cache GETs. Everything else goes through the user worker.
- **Worker returns non-200** — don't cache error responses. Only cache `response.ok`.
