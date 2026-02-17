# ISR (Incremental Static Regeneration) — Design Exploration

## The Problem

Today, Vite Cloud SSR has two modes with no middle ground:

1. **SSG (build-time prerendering)** — Fast (served from R2 + edge cache), but content is frozen until next deploy. Blog posts, marketing pages, product listings — all stale until you redeploy.

2. **Runtime SSR** — Always fresh, but _every request_ hits the user worker. No caching at all. Looking at `dispatch/src/index.ts:95-96`, SSR fallback responses bypass the edge cache entirely:
   ```js
   const worker = env.DISPATCH.get(routing.workerName);
   return worker.fetch(request); // no cacheResponse() wrapper
   ```

ISR fills the gap: serve static-speed responses that automatically refresh in the background.

---

## How ISR Works (the Vercel model)

1. Pages are prerendered at build time (like SSG)
2. Served from cache for N seconds (`revalidate` period)
3. After N seconds, the _next_ request still gets the stale page instantly, but triggers a background re-render
4. The re-rendered page replaces the cached version
5. On-demand revalidation: an API call can instantly invalidate specific pages (e.g., CMS webhook)

Visitors always get a fast response. Freshness is eventual (bounded by `revalidate`).

---

## How It Maps to Our Architecture

The building blocks already exist:

| ISR Concept                    | Vite Cloud Equivalent                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| Build-time prerender           | `__resolvePrerenderPaths()` + `closeBundle` SSG in `plugin-routing.ts` |
| Edge cache                     | `caches.default` in dispatch worker (versioned cache keys)             |
| Origin storage                 | R2 at `{projectId}/current/{path}`                                     |
| Background re-render           | `ctx.waitUntil()` + `env.DISPATCH.get(workerName).fetch()`             |
| Cache invalidation (deploy)    | Versioned cache keys (`?_v={deploymentId}`) — already instant          |
| Cache invalidation (on-demand) | **New** — doesn't exist yet                                            |

The dispatch worker is the natural ISR orchestrator. It already sits between the edge cache and the user worker, and has `waitUntil()` for background work.

---

## Proposed Design

### Storage Model: Two-Layer Cache

```
Request
  │
  ▼
┌─────────────────────────┐
│   CF Edge Cache          │  Per-colo, ephemeral, fast
│   (caches.default)       │  TTL = revalidate seconds
└────────┬────────────────┘
         │ miss
         ▼
┌─────────────────────────┐
│   R2 (ISR store)         │  Global, persistent
│   {projectId}/isr/{path} │  Metadata: generatedAt, revalidate
└────────┬────────────────┘
         │ miss or stale
         ▼
┌─────────────────────────┐
│   User Worker (render)   │  Runtime SSR via dispatch namespace
└─────────────────────────┘
```

**Why two layers?**

- **Edge cache** provides sub-millisecond response times at each CF colo. But it's per-colo and ephemeral — a page might be re-rendered 300 times (once per colo) instead of once globally.
- **R2** provides a single global source of truth. Once any colo re-renders a page, all other colos can read from R2 instead of re-rendering independently.
- Without R2, a cold colo always hits the user worker. With R2, it hits R2 (fast, cheap) and only the _first_ global revalidation hits the worker.

### Request Flow (dispatch worker)

```
GET /blog/hello → myapp.vitecloud.app

1. Extract slug, KV lookup → get routing entry (includes isr config)
2. Build versioned cache key: url + ?_v={version}

3. Edge cache lookup (caches.default.match):
   HIT → return immediately (within revalidate TTL)
   MISS → continue

4. R2 lookup: ASSETS.get("{projectId}/isr/blog/hello/index.html")
   a) HIT + fresh (generatedAt + revalidate > now):
      → serve from R2
      → cache at edge with s-maxage={revalidate}

   b) HIT + stale (generatedAt + revalidate <= now):
      → serve stale from R2 immediately
      → cache at edge (short TTL, maybe 10s, to absorb thundering herd)
      → waitUntil: re-render via worker → write to R2 + edge cache

   c) MISS:
      → render via worker (blocking — visitor waits)
      → write to R2 + edge cache
      → serve response

5. On deploy: ISR entries in R2 are cleared (start fresh).
```

### ISR R2 Key Convention

```
{projectId}/isr/{normalizedPath}/index.html
```

Custom metadata on R2 object:

```json
{
  "x-isr-generated-at": "1708185600000",
  "x-isr-revalidate": "60"
}
```

This is separate from `{projectId}/current/` (deploy-time static assets) so deploys don't interfere with ISR-cached pages.

### Seeding ISR from Build

Pages prerendered at build time (via `export const prerender = [...]`) are uploaded to _both_:

- `{projectId}/current/{path}/index.html` (as today, for the deploy-time static baseline)
- `{projectId}/isr/{path}/index.html` (with `generatedAt = deployTime`, `revalidate` from config)

This means the first request after deploy always gets a pre-rendered page (no cold render needed).

---

## User-Facing API

### Option A: SSR entry-level config (simplest)

```typescript
// src/main.ssr.tsx
export const prerender = ["/", "/blog/hello", "/blog/world"];
export const revalidate = 60; // seconds — all ISR pages share this TTL
```

- `prerender` = which pages to pre-render at build time (existing feature)
- `revalidate` = how often to regenerate (new)
- If `revalidate` is set, _all_ SSR responses are ISR-cached (not just prerendered paths)
- Non-prerendered paths (e.g., `/blog/new-post`) are rendered on first request, then ISR-cached

**Pros:** Dead simple. One number controls everything.
**Cons:** No per-page control. A high-traffic homepage might want 10s revalidation while a blog archive wants 3600s.

### Option B: Response header (per-page control)

```typescript
// src/main.ssr.tsx
export default defineRender(async (c, assetTags) => {
  const html = renderPage(c);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-revalidate": "60", // ISR: regenerate after 60 seconds
    },
  });
});
```

The dispatch worker reads `x-revalidate` from the response and uses it for ISR caching. No header = no ISR caching (pure SSR, as today).

**Pros:** Per-page control. The render function knows the content and can decide the right TTL.
**Cons:** Slightly more ceremony. User must remember to set the header. Dispatch needs to strip it before sending to client.

### Option C: Both (recommended)

```typescript
// src/main.ssr.tsx
export const revalidate = 60; // default for all pages

export default defineRender(async (c, assetTags) => {
  // Override per-page via response header
  if (c.req.path.startsWith("/blog/")) {
    return new Response(html, {
      headers: { "x-revalidate": "3600" }, // blogs: 1 hour
    });
  }
  return new Response(html); // uses default 60s
});
```

- Module-level `export const revalidate` sets the default (included in deploy manifest → KV routing entry)
- Response `x-revalidate` header overrides per-response
- Dispatch applies the default if the response doesn't include the header
- `x-revalidate: 0` explicitly opts out of ISR for that response

---

## On-Demand Revalidation

### API Design

New platform endpoint:

```
POST /projects/:id/revalidate
Authorization: Bearer <token>
Content-Type: application/json

{
  "paths": ["/blog/hello", "/blog/world"]
}
```

Response:

```json
{
  "invalidated": ["/blog/hello", "/blog/world"],
  "rerendered": false
}
```

### What it does

1. **Delete R2 ISR entries** for the specified paths
   - Next request to any edge colo will miss R2 → trigger fresh render
2. **Edge cache is NOT explicitly purged** (CF Workers can't purge programmatic cache across colos)
   - Edge entries expire naturally after `revalidate` seconds
   - Worst case: a visitor gets stale content for up to `revalidate` seconds after invalidation
   - For most use cases (revalidate = 60s), this is fine

### Instant global purge (if needed later)

If the `revalidate` delay on edge cache expiry is unacceptable, there's an escape hatch:

- Use a **per-path version** in KV alongside the deploy version
- On revalidation: bump the path version in KV
- Dispatch builds cache key with both: `?_v={deployVersion}&_pv={pathVersion}`
- Tradeoff: extra KV read per request (path version lookup)

This is more complex and probably not needed for v1. Time-based edge expiry + R2 invalidation is good enough.

### User-facing hook

For convenience, expose a helper importable in route handlers:

```typescript
// routes/api/cms-webhook.ts
import { revalidate } from "vite-cloud/isr";

export const POST = defineHandler(async (c) => {
  const { slug } = await c.req.json();
  await revalidate([`/blog/${slug}`]); // calls platform API
  return { ok: true };
});
```

Under the hood, `revalidate()` calls the platform API with the project's credentials.

---

## Interaction with Existing Features

### Deploy Invalidation

On deploy, all ISR state resets cleanly:

- **Edge cache**: Already invalidated via versioned cache keys (`?_v={newDeploymentId}`)
- **R2 ISR entries**: Cleared on deploy (new build = new content, old ISR entries are stale)
- **Build-time prerendered pages**: Re-seeded into both `current/` and `isr/` R2 paths

### `revalidate` Without `prerender` (Pure SSR + ISR)

The user can set `export const revalidate = 60` without any `prerender` export. This is a pure SSR app with ISR caching. The cache populates **lazily**:

1. Build time: nothing is pre-rendered, R2 ISR store is empty
2. First request to `/blog/hello`: miss everywhere → worker SSR render → store in R2 + edge → serve
3. Within `revalidate` seconds: served from edge cache
4. After `revalidate` seconds: edge miss → R2 has it → serve from R2 → background re-render if stale

First visitor to each path pays the SSR cost. Every subsequent visitor gets cached. The `prerender` list is purely an optimization to pre-warm important paths — it's optional.

### Non-Prerendered Dynamic Paths (with prerender set)

ISR naturally extends to paths not in the `prerender` list:

- `/blog/brand-new-post` (never prerendered) → first visitor waits for SSR → response cached in R2 + edge → subsequent visitors get cached version
- Same lazy population as the "no prerender" case above

### Auth/Personalized Pages

ISR should NOT cache personalized content. The dispatch worker should skip ISR when:

- Request has `Cookie` header (session-based auth)
- Request has `Authorization` header
- The `x-revalidate: 0` header is present on the response

This keeps ISR safe by default for public content.

### API Routes

API routes (`/api/*`) remain unaffected — they always dispatch directly to the user worker with no caching, as today. ISR is exclusively for SSR document responses.

---

## Changes Required (by component)

### Dispatch Worker (`packages/dispatch/`)

The biggest change. The ISR logic lives here:

- New `serveISR()` function: R2 lookup → stale check → background revalidation
- Modified request flow: insert ISR path between edge cache miss and worker dispatch
- Read ISR config from KV routing entry (`isr: { revalidate: 60 }`)
- Read `x-revalidate` header from worker responses to determine per-page TTL
- Strip `x-revalidate` header before sending to client
- Skip ISR for requests with Cookie/Authorization headers
- New `RoutingEntry` field: `isr?: { revalidate: number }`

### Platform (`packages/platform/`)

- New endpoint: `POST /projects/:id/revalidate`
- Deploy endpoint: clear R2 ISR entries on deploy, seed from prerendered pages
- Store ISR config in KV routing entry

### Vite Cloud Plugin (`packages/vite-cloud/`)

- Detect `export const revalidate` from SSR entry (new AST detection in `ssr/entry.ts`, similar to `prerender`)
- Include `revalidate` in deploy manifest
- Build-time: upload prerendered pages to both `current/` and `isr/` R2 paths
- Runtime helper: `vite-cloud/isr` subpath with `revalidate()` function

### CLI (`packages/vite-cloud/src/cli/`)

- Include ISR config in deploy manifest
- Package prerendered pages for ISR seeding

---

## Decisions Made

- **ISR-cached pages are cleared on deploy.** Avoids serving HTML that references old asset hashes. Cold cache after deploy is acceptable.
- **Error during background revalidation:** Serve stale, log the error, don't retry. The next request after `revalidate` seconds will try again naturally.
- **ISR scope:** SSR pages only. API routes remain uncached.
- **Per-page control:** Via `x-revalidate` response header. No first-class `defineRender` API needed for now.

## Open Questions (Future Phases)

1. **Thundering herd on revalidation.** When an edge cache entry expires, multiple concurrent requests could all trigger revalidation simultaneously. Future mitigation: use a "revalidating" flag in R2 metadata or a KV lock so only one request triggers the actual re-render. Not needed for v1.

2. **R2 cost at scale.** Each ISR page read is an R2 GET (Class B operation). At $0.36/million reads, a page getting 1M requests/day with 60s revalidation = ~1440 R2 reads/day/colo \* 300 colos = ~430K R2 reads/day. Negligible — the edge cache absorbs the vast majority of traffic.
