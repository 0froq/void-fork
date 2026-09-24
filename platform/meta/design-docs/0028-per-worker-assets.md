---
title: Worker and Static Asset Serving
status: implemented
---

# Worker and static asset serving

Worker-backed deployments attach Cloudflare per-worker assets so the user
Worker can fetch its own files through the ASSETS binding. Dispatch uses that
native asset path for ordinary Worker requests. This supports frameworks
that expect the Cloudflare assets binding without embedding an asset manifest
inside their code.

Static-only deployments use content-addressed KV and R2 storage and need no
Workers for Platforms user Worker. Worker-backed deploys also mirror asset
bytes to the platform store so dispatch can serve the verified R2 fallback
when Cloudflare's asset deduplication returns a known poisoned response.
The mirror is a safety net, not the normal asset path.

The current deployment and serving paths are in
[deploy](../../packages/api/src/routes/deploy.ts) and
[dispatch](../../packages/dispatch/src/index.ts).
