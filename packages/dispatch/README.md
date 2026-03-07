# @voidcloud/dispatch

Routes `*.void.app` traffic to user workers and static assets. CF Worker using plain `fetch` handler (no framework).

## Request Flow

1. Extract slug from hostname (`{slug}.void.app`)
2. KV lookup: `slug → { workerName, projectId, version, limits?, suspended? }` or `slug → { staticDeploymentId, projectId, version, suspended? }`
3. **Suspension check**: If `routing.suspended` is set → return 429 `{ error: "usage limit exceeded", reason }`
4. Edge cache check via `caches.default` with versioned cache key (`?_v={version}`)
5. **Static projects** (`staticDeploymentId` in routing): served directly from `STATIC_ASSETS` KV (primary) with `STATIC_ASSETS_R2` R2 overflow for large files. Path resolution handled by `resolveStaticPath()` in `src/static.ts` (SPA fallback to `index.html`, directory index resolution). Asset hashes prefixed with `!` are fetched from R2 instead of KV.
6. `/api/*` → `getWorker(env, routing).fetch(request)` with custom limits (Workers for Platforms, not cached). CPU limit errors caught → 429
7. Everything else → serve static assets from R2 (SPA fallback to `index.html`) or ISR cache from KV, cache response at edge
8. **Metering**: Every request (except 404/suspended) records an Analytics Engine data point via `ctx.waitUntil` (fire-and-forget, zero latency impact)

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
  env.ts                    # Env interface (DISPATCH, ISR_CACHE, ROUTING, STATIC_ASSETS, STATIC_ASSETS_R2, ANALYTICS, BASE_HOSTNAME?)
  hostname.ts               # extractSlug() — pure function
  static.ts                 # serveStaticAsset() — R2 lookup, SPA fallback, cache headers
                            # resolveStaticPath() — KV/R2-backed static serving for static/SPA deployments
  isr.ts                    # ISR cache read/write/delete — KV with binary pack format
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

Two layers of edge caching ensure user workers are only invoked when necessary.

### Hashed Assets

Hashed assets use version-independent cache keys — their content is guaranteed by the filename hash, so they survive across deploys and avoid unnecessary worker invocations after redeployment. The default prefix is `/assets/*` (Vite convention), with built-in presets for supported meta-frameworks (e.g., `/_nuxt/*`).

- `Cache-Control: public, max-age=31536000, immutable` — cached at edge ~1 year

### Static Assets

Non-hashed static assets are edge-cached using deploy-versioned cache keys (`?_v={version}`). On each deploy, the version changes and all previous cache entries are automatically invalidated — no purge API needed.

- `Cache-Control: public, s-maxage=31536000, max-age=0, must-revalidate` — cached at edge until next deploy

**What gets cached:**

- All GET requests for non-SSR projects (SPA/static sites) — every path is static
- GET requests with file extensions (`.ico`, `.png`, `.css`, etc.) in SSR projects

**What does NOT get cached:**

- `/api/*` routes
- SSR-rendered pages (paths without file extensions in SSR projects)
- Non-GET requests
- Non-2xx responses
- Responses where the worker sets `Cache-Control: private`, `no-store`, or `no-cache`

**Opting out:** To prevent a response from being cached (e.g., dynamically generated images at a static-looking URL), set `Cache-Control: private` or `Cache-Control: no-store` in your worker response.

## Tests

| Test file                    | Covers                                      |
| ---------------------------- | ------------------------------------------- |
| `test/unit/hostname.test.ts` | Slug extraction from hostname (18 tests)    |
| `test/unit/metering.test.ts` | Analytics Engine data point shape (5 tests) |
