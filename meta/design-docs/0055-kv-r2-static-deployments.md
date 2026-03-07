---
title: KV/R2-Based Static Deployments
status: draft
created: 2026-03-07
depends: [0028-per-worker-assets, 0054-versioned-deployments]
---

# KV/R2-Based Static Deployments

## Summary

Static-only deployments (type `"static"` / `"spa"`) bypass Workers for Platforms entirely. Assets are stored with content-addressed keys in KV (primary, globally distributed) with R2 fallback for files >= 2 MB. Dispatch serves them directly. This eliminates the $0.02/mo per-script cost for retained static deployments, enabling 100 retained deployments for all tiers regardless of plan.

## Motivation

Every WfP user worker script costs $0.02/mo. With versioned deployments (0054), each retained deployment is a separate script. This forces low retention limits (free: 1, solo: 5, pro: 25), making Void's static hosting uncompetitive versus Vercel (100) and Netlify (unlimited retained deployments).

Static sites use a trivial passthrough worker (`env.ASSETS.fetch(request)`) — paying $0.02/mo per retained deployment for this is wasteful.

### Cost Comparison

With content-addressed storage across 100 retained deployments (20 MB avg site, ~5% churn per deploy, ~120 MB effective storage):

| Approach          | Cost/user/mo | At 1K users | At 10K users |
| ----------------- | ------------ | ----------- | ------------ |
| **WfP (current)** | $2.00        | $2,000      | $20,000      |
| **KV-primary**    | $0.06        | $60         | $600         |
| **R2-only**       | $0.002       | $2          | $20          |

KV is 33x cheaper than WfP while providing the same globally-distributed read performance. R2 is cheaper still but has single-region latency on cold reads (50-200ms from distant colos). The hybrid approach uses KV for performance-critical serving and R2 only as overflow for files >= 2 MB.

## Design

### Two-Tier Content-Addressed Storage

Assets are stored with content-addressed keys across two backends:

- **KV** (primary): `STATIC_ASSETS` KV namespace — assets < 2 MB
  - Globally distributed, low-latency reads from any colo
  - Built-in edge caching via `cacheTtl` parameter
  - Content-Type stored as KV metadata
  - Key: `assets/{hash}` (32-char hex, SHA-256 truncated)
  - Covers all latency-sensitive assets: HTML, CSS, JS bundles, fonts, small images

- **R2** (overflow): `STATIC_ASSETS_R2` R2 bucket — assets >= 2 MB
  - Single-region storage for large files (images, videos, PDFs, source maps)
  - Content-Type stored as R2 httpMetadata
  - Key: `assets/{hash}` (same scheme)
  - These assets are typically lazy-loaded or streamed, so cold-read latency is acceptable

The 2 MB threshold is chosen because all render-blocking web assets (HTML, CSS, JS, fonts) are well under 2 MB. Assets above 2 MB are almost always lazy-loaded media where R2's single-region latency is not user-visible. This keeps KV costs ~6x lower than using the full 25 MB KV limit while covering all performance-critical files.

Single shared namespace/bucket across all projects — assets are opaque by hash, natural deduplication. Content-addressing means unchanged assets between deployments cost zero additional storage or upload time.

### Deploy Flow (Static-Only)

Replaces the current flow that creates a WfP passthrough worker:

1. **Preflight** (unchanged): CLI sends asset hashes, API responds with which hashes need uploading
2. **Upload**: CLI sends only changed assets. API routes each asset by size:
   - < 2 MB → KV PUT at `assets/{hash}` with content-type metadata
   - > = 2 MB → R2 PUT at `assets/{hash}` with httpMetadata
   - Both check existence first (content-addressed dedup)
3. **Manifest**: API stores the deployment's path-to-hash manifest in `ROUTING` KV (`manifest:{deploymentId}`) and DB (`asset_hashes` column). Manifest includes a `large` flag for R2-stored assets.
4. **Routing**: API updates `ROUTING` KV with `staticDeploymentId` (no `workerName`) and `assetConfig`
5. **Retention cleanup**: evict oldest static deployments beyond the 100-deployment limit
6. **No WfP script created** — no worker upload, no asset upload session, no JWT dance

### Per-Deployment Manifest

Each deployment's asset manifest maps paths to content hashes:

```json
{
  "/index.html": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "/assets/main.js": "f7e8d9c0b1a2f7e8d9c0b1a2f7e8d9c0",
  "/assets/style.css": "1234567890abcdef1234567890abcdef",
  "/videos/intro.mp4": "!abcdef1234567890abcdef1234567890"
}
```

Values prefixed with `!` indicate R2-stored assets (>= 2 MB). Stored in `ROUTING` KV at `manifest:{deploymentId}`. Since a deployment's manifest is immutable, dispatch reads it with a long `cacheTtl` (24 hours) for per-colo edge caching — no in-memory caching needed in the worker.

### Serving Flow (Dispatch)

When dispatch identifies a request for a static deployment:

1. KV routing lookup returns `staticDeploymentId` + `assetConfig` (existing 60s TTL cache)
2. **Edge cache check** (`caches.default`) with versioned key `{url}?_v={deploymentId}` (existing pattern)
3. On cache miss:
   a. Fetch manifest from `ROUTING` KV (`manifest:{deploymentId}`, `cacheTtl: 86400`)
   b. Resolve request path using AssetConfig rules (see below)
   c. Look up resolved path in manifest to get hash
   d. If hash starts with `!` (R2): fetch from `STATIC_ASSETS_R2.get(`assets/{hash}`)`
   e. Otherwise (KV): fetch from `STATIC_ASSETS.get(`assets/{hash}`, { type: "arrayBuffer", cacheTtl: 86400 })`
   f. Set `Content-Type` from KV metadata or R2 httpMetadata, cache headers
   g. Populate `caches.default` edge cache
4. Meter the request as `"static"` (existing metering, unchanged)

**KV edge caching bonus:** KV's `cacheTtl` provides per-colo edge caching at the asset level. Because keys are content-addressed, this cache is shared across deployments — if deployment A and B share a hash, warming it for A benefits B. This is on top of `caches.default` (keyed by versioned URL).

### AssetConfig Resolution (Full Parity)

Dispatch replicates Cloudflare's built-in asset serving behavior:

**`html_handling`:**

- `"auto-trailing-slash"` (default): try `{path}`, `{path}.html`, `{path}/index.html`
- `"force-trailing-slash"`: redirect `/{path}` → `/{path}/`, serve `/{path}/index.html`
- `"drop-trailing-slash"`: redirect `/{path}/` → `/{path}`, serve `/{path}.html`
- `"none"`: exact path match only

**`not_found_handling`:**

- `"single-page-application"`: fallback to `/index.html` (SPA mode)
- `"404-page"`: serve `/404.html` with 404 status
- `"none"`: return 404

### Routing Entry Changes

```ts
interface RoutingEntry {
  // existing fields (workerName, projectId, ssr, version, limits, etc.)
  workerName?: string; // set for worker deployments

  // new fields for static deployments:
  staticDeploymentId?: string; // set for static deployments
  assetConfig?: AssetConfig; // SPA fallback, html_handling, 404 page
}
```

`workerName` and `staticDeploymentId` are mutually exclusive for serving. Dispatch checks `staticDeploymentId` first; if absent, falls through to the existing WfP path.

### Retention

- **Static deployments:** 100 for all tiers (constant, not tier-bound)
- **Worker deployments:** unchanged (free: 1, solo: 5, pro: 25)
- Retention limit is determined by project type at deploy time

```ts
export const STATIC_RETENTION_LIMIT = 100;
```

### Content-Addressed Cleanup

When evicting a static deployment:

1. Read evicted deployment's `asset_hashes` from DB
2. Query all other retained deployments for the same project
3. Collect their hashes into a `Set`
4. Delete from KV/R2 only hashes not referenced by any retained deployment
5. Delete manifest from `ROUTING` KV (`manifest:{deploymentId}`)
6. Mark deployment as `retained: false` in DB

```ts
const evictedHashes = new Set(Object.values(evicted.assetHashes).map((a) => a.hash));
const retainedHashes = new Set<string>();
for (const dep of otherRetainedDeployments) {
  for (const { hash } of Object.values(dep.assetHashes)) {
    retainedHashes.add(hash);
  }
}
for (const hash of evictedHashes) {
  if (!retainedHashes.has(hash)) {
    const key = `assets/${hash}`;
    // Delete from both — only one will have it, the other is a no-op
    await env.STATIC_ASSETS.delete(key);
    await env.STATIC_ASSETS_R2.delete(key);
  }
}
await env.ROUTING.delete(`manifest:${deploymentId}`);
```

### Rollback

Same mechanism as worker deployments: update KV routing to point to the target `staticDeploymentId`. All assets remain in KV/R2 (content-addressed, shared across deployments). Instant.

### Bindings

**`STATIC_ASSETS`** — KV namespace (primary asset store, < 2 MB):

- API worker: read/write during deploy, delete during eviction
- Dispatch worker: read during serving

**`STATIC_ASSETS_R2`** — R2 bucket (overflow, >= 2 MB):

- API worker: read/write during deploy, delete during eviction
- Dispatch worker: read during serving

Naming:

- KV: `void-static-assets` / `void-static-assets-staging`
- R2: `void-static-assets-overflow` / `void-static-assets-overflow-staging`

### Transition

**Hard cutoff.** On the first KV/R2-based deploy for a static project:

1. New deployment goes to KV/R2 (new flow)
2. All previously retained static deployments have their WfP scripts deleted and are marked `retained: false`
3. The former active deployment's WfP script is also deleted (traffic now served from KV/R2)

Existing static projects that haven't redeployed continue to work on WfP until their next deploy.

### What Doesn't Change

- Worker-based deployments (void, framework) — entirely unchanged
- Deploy manifest format — no version bump needed
- Preflight dedup — still works (CLI sends hashes, API responds with what's needed)
- Edge caching in dispatch — same versioned-key pattern, different origin (KV/R2 vs WfP)
- Metering — same analytics engine recording
- Database schema — `asset_hashes` column already stores the manifest; `retained` boolean unchanged
- Hashed asset caching — still works via `hashedAssetsPrefix` in routing entry
