---
title: Deferred Page Props
status: implemented
---

# Deferred page props

A page loader can wrap slow values with defer so the initial page shell and
immediate props render first. The server runs the loader once and streams each
deferred group over the same response. Initial HTML carries resolution
scripts; client navigation uses a newline-delimited page response. The
client updates the matching deferred state as groups settle.

Prefetch requests resolve deferred values into a regular JSON payload before
caching it, so a prefetched navigation does not reuse an incomplete stream.
This design keeps deferred data tied to the page request and its existing
authentication context.

The shared protocol is implemented in
[Pages protocol](../../../packages/void/src/pages/protocol.ts) and
[defer](../../../packages/void/src/pages/defer.ts).
