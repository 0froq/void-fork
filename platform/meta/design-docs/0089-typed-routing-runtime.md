---
title: Typed routing runtime
status: implemented
created: 2026-10-02
---

# Typed routing runtime

## Contract

The router compiler emits application imports, route/page metadata, lazy loaders
and factory calls. Typed Worker-safe production modules own ordinary request
execution: request context, rewrites and redirects, headers and fallbacks, HTTP
return conversion, Pages loaders/actions, client assets, error rendering and
Worker fetch wiring. Registration and feature-specific module exports remain
in generated entries.

`routing.ts` owns each app's recursive dispatch state and imports the asset,
Pages, error and Worker modules. The compiler resolves its packaged path through
the private `#self/runtime/routing` import, using the existing package convention.
Public exports and package-root rewriting remain unchanged.

## Preserved behavior

Keep middleware ordering, original URLs and rewrite guards, managed routing,
asset and SPA fallback, HEAD behavior, Pages protocol and layouts, manifest and
dev CSS loading, request-local environment scopes, hidden platform bindings,
internal endpoint authentication, ISR and error overlays. Development loaders
refresh while production loaders cache and retry rejected imports. The emitted
runtime adds no provider bindings, provisioning calls or plan requirements.

## Verification

Behavioral tests call production runtime functions directly. Remove duplicated
middleware implementations and replace brittle execution-source assertions with
metadata assertions and behavior tests. Run generated development and production
Workers through real workerd using the packed runtime, then verify framework,
Pages and native/managed build artifacts through affected tests and the full
repository gate. Document these maintainer boundaries without adding internal
refactor history to consumer guides. Commit separately on main without pushing.

Focused runtime and compiler regressions passed. Actual generated development
and production Workers ran the packed runtime in workerd, exercising middleware,
rewrites, fallbacks and the Pages protocol. Framework, Pages, resource identity
and native/managed build coverage passed in the complete repository gate.
Final `vpr test:all` passed formatting, lint, package/platform/playground builds,
artifact checks, platform lint, typechecking and all 641 test files:
11,897 tests passed, 25 skipped. No live provider deployment was needed.
