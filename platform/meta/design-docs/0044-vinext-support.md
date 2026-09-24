---
title: Vinext Framework Support
status: implemented
---

# Vinext framework support

Void recognizes vinext App Router and Pages Router projects as framework
deployments. The Vite plugin and deploy pipeline select the matching server
entry, preserve the framework build output, and provision inferred
Cloudflare bindings. Vinext owns its rendering and route conventions; Void
supplies the deployment and platform integration.

The managed deploy path resolves the framework's asset policy without
rewriting a user-owned complete Wrangler asset configuration. The current
integration is in [the Void plugin](../../../packages/void/src/index.ts)
and [framework inference](../../../packages/void/src/plugin-inference.ts).
