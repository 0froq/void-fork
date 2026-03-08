# @voidcloud/dispatch

Edge router for deployed Void apps. It routes requests to user workers, serves static deployments, manages ISR caching, applies redirect/header rules, and records request usage.

## Request Flow

1. Extract slug from hostname or fall back to `domain:{hostname}` routing.
2. Read routing data from `ROUTING` KV.
3. Reject suspended projects with `429`.
4. Apply redirect rules before any worker invocation.
5. Serve hashed assets from edge cache when possible.
6. For static/SPA projects, serve files from `STATIC_ASSETS` KV with `STATIC_ASSETS_R2` overflow for large assets, using `assetConfig` path resolution.
7. For `/api/*`, forward to the user worker in the dispatch namespace with plan-specific CPU/subrequest limits.
8. For SSR with ISR enabled, use `caches.default` plus `ISR_CACHE` KV for stale-while-revalidate behavior.
9. Apply header rules and record usage in Analytics Engine. If `userId` is present on the routing entry, enqueue usage events as well.

## Static and ISR Storage

- **Static/SPA deploys**: manifest in `ROUTING`, assets in `STATIC_ASSETS` KV, overflow in `STATIC_ASSETS_R2`
- **ISR cache**: packed HTML/headers stored in `ISR_CACHE` KV, with edge-cache copies in `caches.default`
- **Hashed assets**: immutable edge-cache entries keyed by URL path

## Queue Relay

The dispatch worker also exports `queue()`:

1. Cloudflare delivers a `MessageBatch`
2. `queue:{queueId}` is resolved from `ROUTING` KV
3. The batch is serialized and forwarded to the active user worker at `/__queue`
4. Success acks the whole batch; failure retries the batch

## Source Layout

```text
src/
  index.ts        # Main fetch + queue handlers
  hostname.ts     # Hostname/slug extraction
  static.ts       # Static manifest path resolution + content types
  isr.ts          # ISR cache packing, KV read/write, edge cache keys
  redirects.ts    # Redirect rule matching
  headers.ts      # Header rule application
  metering.ts     # Analytics Engine writes + usage queue events
  constants.ts
  env.ts
test/unit/
  index.test.ts
  hostname.test.ts
  static.test.ts
  isr.test.ts
  redirects.test.ts
  headers.test.ts
  metering.test.ts
```

## Metering

Any request that resolves to a routing entry and is not suspended records:

- project ID
- request type (`api`, `static`, `ssr`, `isr`)
- method
- status
- response bytes
- duration
- slug/hostname

Analytics Engine is the source for usage reporting. Dispatch also publishes lightweight usage events to `USAGE_QUEUE` when the routing entry includes a `userId`.

## Edge Caching

- **Hashed assets**: `Cache-Control: public, max-age=31536000, immutable`
- **Versioned static assets**: `s-maxage=31536000, max-age=0, must-revalidate`
- **ISR HTML/JSON**: edge cache backed by `ISR_CACHE` KV

Not cached:

- `/api/*`
- non-GET requests
- private/no-store/no-cache responses
- SSR pages without ISR

## Tests

- `test/unit/index.test.ts` — main routing behavior
- `test/unit/static.test.ts` — static path resolution and serving
- `test/unit/isr.test.ts` — ISR cache packing and TTL behavior
- `test/unit/redirects.test.ts` — redirect rule matching
- `test/unit/headers.test.ts` — header rule application
- `test/unit/hostname.test.ts` — slug extraction
- `test/unit/metering.test.ts` — Analytics Engine payload shape
