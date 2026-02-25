---
outline: deep
---

# Prerendering

Pages with long revalidate TTLs (e.g. 1 year) are effectively static, but the first visitor after a deploy hits a cold cache. You can opt pages into **prerendering** — the platform renders them at deploy time and writes the result to the ISR cache so the first visitor gets an instant response.

## Static pages (no params)

Export `prerender = true` from the companion `.server.ts` file:

```ts
// pages/about.server.ts
export const prerender = true;
export const revalidate = 31536000; // 1 year

export const loader = defineHandler(async (c) => {
  // ...
});
```

Pages with no dynamic params are automatically prerendered at their URL pattern (e.g. `/about`).

## Dynamic pages (with params)

For pages with URL params, also export `getPrerenderPaths()` to specify which param combinations to prerender:

```ts
// pages/blog/[slug].server.ts
export const prerender = true;
export const revalidate = 31536000;

export async function getPrerenderPaths() {
  // Return param objects matching the URL pattern
  return [{ slug: "hello-world" }, { slug: "getting-started" }];
}

export const loader = defineHandler(async (c) => {
  // ...
});
```

## Custom SSR

In custom SSR mode (`src/main.ssr.ts`), export `getPrerenderPaths()` at the top level. Since there's no file-based routing, return full path strings:

```ts
// src/main.ssr.ts
export const prerender = true;

export async function getPrerenderPaths() {
  return ["/", "/about", "/blog/hello-world"];
}

export default defineRender(async (c, assetTags) => {
  // ...
});
```

## Behavior

- Only paths with a positive revalidate TTL are prerendered (TTL `0` is skipped)
- Prerender failures are logged but never block the deploy — the page will be rendered on the first request as usual
- The deployment status shows `"prerendering"` during this phase
- Prerendering happens after the worker is uploaded but before the routing entry goes live

## Deploy behavior

Each deploy clears the ISR cache for the project. This ensures stale content from a previous deploy is never served. Prerendered pages are written to the cache after clearing, so they're ready for the first request. Hashed static assets are unaffected.
