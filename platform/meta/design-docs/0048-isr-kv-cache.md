---
title: ISR Cache in KV
status: implemented
---

# ISR cache in KV

ISR uses an edge cache for nearby responses and a persistent KV namespace
for cached page entries. The KV value packs response headers and body bytes;
metadata records status, creation time, TTL, and cache policy version.
Keys scope entries to the project, deployment, host, and path so unrelated
versions or domains do not share rendered HTML.

A cache miss or failed KV read falls back to rendering. The direct runtime also
tolerates other KV operation failures. Revalidation removes the persistent
entry and purges the relevant edge variant. This replaced the earlier
R2-backed ISR store while preserving the two-layer serving model. The
implementations are in
[ISR runtime](../../../packages/isr/src/runtime.ts) and
[platform dispatch](../../packages/dispatch/src/isr.ts).
