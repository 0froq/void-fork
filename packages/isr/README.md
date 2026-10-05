# @void/isr

Shared incremental revalidation helpers for Void runtimes and deployment adapters. Applications use `void/isr` to revalidate pages; see the [Revalidation guide](https://void.cloud/guide/edge/revalidation).

For runtime authors, the package provides three entry points:

- `@void/isr`: versioned cache keys and edge-cache URLs
- `@void/isr/core`: codecs, cache policy, TTL selection, and response helpers
- `@void/isr/runtime`: the direct Cloudflare KV and Cache API runtime

The writer and purger must use the same key helpers. Keep incompatible format changes behind a new cache-key version. See the [source](./src/index.ts) for the format contract and [Platform Development](https://void.cloud/guide/platform-development) for runtime work.
