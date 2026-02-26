---
outline: deep
---

# Prerendering

You can instruct Void to prerender a page so that the page is served immediately from the cache after a new deploy.

- [Markdown pages](../pages-routing/markdown.md) are auto-prerendered.
- [Island pages](../islands.md) with no companion loader and no dynamic params are also auto-prerendered.

## Static pages (no params)

Export `prerender = true` from the companion `.server.ts` file:

```ts
// pages/about.server.ts
export const prerender = true;

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

## Relationship to revalidation

Pages with long revalidate TTLs (e.g. 1 year) are effectively static, but the first visitor after a deploy hits a cold cache. This is where prerendering helps - it ensures your users never get slow requests.

Enabling prerendering for a page automatically sets `revalidate` to 1 year, so you don't need to export it yourself. Since the ISR cache is cleared on every deploy, the TTL only needs to be long enough to last between deploys.

You can also explicitly set to it a different value to override the default:

```ts
// pages/about.server.ts
export const prerender = true;
export const revalidate = 3600;
```

Just be aware that if no new deploy happens before the revalidate expires, the first user request after expiration will miss the cache and incur a full render.

## Relationship to SSG

Unlike SSG (Static Site Generation), prerendering with Void does not happen during the build - i.e. there will be no static HTMLs uploaded. Instead, the rendering happens on the platform, where we can deploy your app in the production environment and prerender what your users will actually see.

## Behavior details

- Prerender happens once per deployment, before traffic is routed to the new version of the app. When the switch happens, the prerendered pages are already cached at the edge.
- Only paths with a positive revalidate TTL are prerendered (TTL `0` is skipped)
- Prerender failures are logged but never block the deploy — the page will be rendered on the first request as usual
- The deployment status shows `"prerendering"` during this phase
- Prerendering happens after the worker is uploaded but before the routing entry goes live
- Each deploy clears the ISR cache for the project. This ensures stale content from a previous deploy is never served. Prerendered pages are written to the cache after clearing, so they're ready for the first request. Hashed static assets are unaffected.
