---
title: Persistent resource names
status: implemented
created: 2026-10-02
---

# Persistent resource names

## Contract

Keep every existing unnamed Durable State binding, class and migration tag, and
WebSocket class and ordered instance key unchanged. Optional static `name` pins
the existing identity before moving source. It belongs to `defineDurableState`,
`defineRoom` and `defineWebSocket`; it does not rename the HTTP endpoint or an
individual Durable Object instance.

`void info [--json]` uses shared application analysis locally, without executing
application source, authentication, provisioning or file writes. It displays
each current resource and this requested instruction:

```text
To preserve this resource when moving its code, add this to 'defineRoom':
  name: "chat-room",
```

Unmatched local identities in the existing `void.lock.json` are shown separately.
Suggestions must roundtrip to the recorded class/binding and, for Durable State,
the recorded migration tag. The CLI never guesses which moved definition owns
an old resource. Unknown identities require restoring the original source from
history to discover its name. No additional ledger or provider lookup is added.

## Implementation

The shared AST reader discovers static names, local constants, static spreads,
helper aliases and namespace imports. Dynamic explicit names fail; existing
unnamed dynamic definitions retain their prior scanning behavior. Identity
collision checks run before resource synchronization. Worker code imports only
the small name validator; parsing stays in tooling.

Generated class metadata and Durable State `__bind()` carry the authored name.
Runtime mismatches fail at startup instead of silently binding named definitions
to filename-derived replacements. The existing Cloudflare migration planner,
manifest versions, public imports and deployment orchestration remain in place.

For WebSocket parameter renames, optional synchronous `key({ params })` retains
the complete old key. Both request namespace selection and Durable Object hook
contexts use the callback. Without it, no-parameter routes use `default` and
parameter routes use ordered `name=value` pairs. Pinning a class alone cannot
preserve instances after parameter names change.

Custom Durable State still supports native Cloudflare only. WebSockets retain
native and managed platform support. This feature emits no new bindings and
requires no paid product or entitlement probe.

## Verification

Run focused scanner, runtime, compiler and CLI tests first, then affected tests
and package typechecking. Verify actual generated Workers with persisted
Miniflare state across unnamed → pinned → moved → parameter-renamed stages,
including unchanged config/lock bytes, hosted class lists, independent instances
and old-route retirement. Exercise the public plugin build and built CLI.

Update the public guides, API/CLI references and bundled skill; build docs to
check references. Run `vpr test:all` once for final repository verification.
Commit coherent work directly on main without pushing.

Focused scanner, runtime and CLI regressions passed. The generated Worker test
retained actual Durable RPC and WebSocket storage through all four stages, with
byte-identical native configuration and lock history, unchanged hosted class
lists and independent instances. A separate public `voidPlugin()` build ran its
complete production artifact in Miniflare and served RPC and the custom room key.
Built CLI subprocess tests exercised offline discovery, pinning and moving.

`vp run test --list` selected the full conservative fallback for maintainer
metadata; `vp run test` passed all 637 files. `vp run check` and the docs build
passed. Final `vpr test:all` passed formatting, lint, package/platform/playground
builds, artifact checks, platform lint, typechecking and the full suite:
11,862 tests passed, 25 skipped. Provider tests were not enabled; no remote
platform deployment or mutation was needed for this SDK change.
