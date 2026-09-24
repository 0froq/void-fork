---
title: Workers for Platforms Asset Fallback
status: implemented
---

# Workers for Platforms asset fallback

Cloudflare's asset upload deduplication can acknowledge a content hash while an asset is unavailable. Void keeps Cloudflare's native asset binding as the primary serving path and stores a platform-owned asset mirror with a deployment manifest.

Dispatch inspects responses that resemble Cloudflare's missing-asset stub. After confirming the marker, it resolves the requested path from the manifest and serves the mirrored bytes from KV or R2. A confirmed stub with no usable mirror yields an attributed platform error instead of a cacheable HTTP 200 stub. Other responses pass through unchanged. Successful fallbacks and missing mirrors emit structured events.

The upload and manifest path is in [deployment handling](../../../platform/packages/api/src/routes/deploy.ts); the response check and fallback are in [dispatch](../../../platform/packages/dispatch/src/index.ts).
