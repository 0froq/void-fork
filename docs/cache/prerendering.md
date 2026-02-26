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

## Static output mode

Set `output: "static"` in `void.json` to prerender all pages at build time:

```json
{
  "output": "static"
}
```

When `output` is `"static"`:

- All pages default to `prerender = true` — they are rendered during `vite build` and written as HTML files to `dist/client/`.
- Use `export const prerender = false` in a page's `.server.ts` to opt out — that page will be server-rendered on request.
- Dynamic pages without `getPrerenderPaths()` are implicitly not prerendered (the paths aren't known at build time).
- The build output is self-contained and works for `wrangler deploy`, self-hosting, or `void deploy`.

| `output` value       | Default prerender | Per-page override                | Prerender timing           |
| -------------------- | ----------------- | -------------------------------- | -------------------------- |
| `"server"` (default) | `false`           | `export const prerender = true`  | Deploy-time (platform ISR) |
| `"static"`           | `true`            | `export const prerender = false` | Build-time (`vite build`)  |

When `output` is omitted or `"server"`, behavior is unchanged — `export const prerender = true` opts individual pages into deploy-time ISR prerendering.

## Relationship to `mode: "ssg"`

The `mode` field describes app type (SPA, SSG, fullstack), while `output` controls rendering strategy:

|              | `mode: "ssg"`                                   | `output: "static"`                   |
| ------------ | ----------------------------------------------- | ------------------------------------ |
| **What**     | Deploy a pre-built static site (no Void plugin) | Prerender a Void app at build time   |
| **Worker**   | None (static assets only)                       | Yes (for non-prerendered routes)     |
| **Use case** | VitePress, plain HTML, external SSG tools       | Void apps with mostly static content |

## Deploy-time prerendering

When `output` is `"server"` (default), prerendering happens on the platform at deploy time — not during the build. The platform invokes the uploaded worker and writes results to the edge cache.

## Behavior details

- **Deploy-time** (`output: "server"`): Prerender happens once per deployment, before traffic is routed to the new version. Prerendered pages are cached at the edge. Each deploy clears the ISR cache. The deployment shows `"prerendering"` during this phase.
- **Build-time** (`output: "static"`): Prerender runs locally during `vite build`. Miniflare spins up with the built worker and renders each page. HTML files are written to `dist/client/` and deployed as static assets. No deploy-time prerender step is needed.
- Only paths with a positive revalidate TTL are prerendered (TTL `0` is skipped)
- Prerender failures are logged but never block the deploy or build — the page will be rendered on the first request as usual
