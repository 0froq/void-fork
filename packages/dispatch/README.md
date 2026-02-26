# @voidcloud/dispatch

Routes `*.voidcloud.dev` traffic to user workers and static assets. CF Worker using plain `fetch` handler (no framework).

## Request Flow

1. Extract slug from hostname (`{slug}.voidcloud.dev`)
2. KV lookup: `slug → { workerName, projectId, version, limits?, suspended? }`
3. **Suspension check**: If `routing.suspended` is set → return 429 `{ error: "usage limit exceeded", reason }`
4. Edge cache check via `caches.default` with versioned cache key (`?_v={version}`)
5. `/api/*` → `getWorker(env, routing).fetch(request)` with custom limits (Workers for Platforms, not cached). CPU limit errors caught → 429
6. Everything else → serve static assets from R2 (SPA fallback to `index.html`), cache response at edge
7. **Metering**: Every request (except 404/suspended) records an Analytics Engine data point via `ctx.waitUntil` (fire-and-forget, zero latency impact)

## Queue Relay

The dispatch worker also exports a `queue()` handler for Cloudflare Queue batch relay:

1. CF delivers `MessageBatch` to dispatch worker's `queue()` export
2. KV lookup: `queue:<queueId>` → `{ workerName, projectId, queueName }`
3. Serialize batch to JSON (`{ queue, messages: [{id, timestamp, body, attempts}] }`)
4. Forward to user worker: `env.DISPATCH.get(workerName).fetch("/__queue", serializedBatch)`
5. Ack all on success, retry all on failure

## Source Layout

```
src/
  index.ts                  # Main fetch handler + suspension check + custom limits
  env.ts                    # Env interface (DISPATCH, ASSETS, ROUTING, ANALYTICS, BASE_HOSTNAME?)
  hostname.ts               # extractSlug() — pure function
  static.ts                 # serveStaticAsset() — R2 lookup, SPA fallback, cache headers
  metering.ts               # recordRequest() — Analytics Engine writeDataPoint wrapper
```

## Metering (Analytics Engine)

Every request is recorded via `recordRequest()` using `ctx.waitUntil` (non-blocking). Data point schema:

| Field   | Value                                 |
| ------- | ------------------------------------- |
| index   | projectId (sampling key)              |
| blob1-5 | projectId, type, method, status, slug |
| double1 | 1 (for SUM counting)                  |
| double2 | responseBytes                         |
| double3 | durationMs                            |

Request types: `"api"`, `"static"`, `"ssr"`, `"isr"`. Usage queries multiply by `_sample_interval` for accuracy at high traffic.

## Edge Caching

Static asset responses are cached at the CF edge via `caches.default`. Cache keys include a `version` from the KV routing entry (set to the deployment ID on each deploy), so new deploys instantly invalidate stale entries without purge APIs. Hashed assets (`/assets/*`) use version-independent cache keys — their content is guaranteed by the filename hash, so they survive across deploys and avoid unnecessary R2 reads after redeployment.

- Hashed assets (`assets/*-<hash>.js`) get `Cache-Control: public, max-age=31536000, immutable` — cached at edge ~1 year, cache key is unversioned
- Non-hashed assets (`index.html` etc.) get `Cache-Control: public, s-maxage=60, max-age=0, must-revalidate` — cached at edge 60s, cache key includes deploy version
- API routes and SSR-rendered responses are **not** edge-cached
- Non-file paths fall back to `index.html` (SPA routing)

## Tests

| Test file                    | Covers                                      |
| ---------------------------- | ------------------------------------------- |
| `test/unit/hostname.test.ts` | Slug extraction from hostname (18 tests)    |
| `test/unit/metering.test.ts` | Analytics Engine data point shape (5 tests) |
