---
title: Typed Cloudflare transport
status: implemented
created: 2026-10-02
---

# Typed Cloudflare transport

## Contract

App deployment and platform installation keep their existing orchestration.
Provider requests use the discriminated `CloudflareOperation` contract in
`@void/deploy-cloudflare`. Public targets are fields; secrets and Hyperdrive
connection strings use stdin or private temporary files. Results carry provider
data, codes, errors and process provenance. Diagnostics remain human text.

The private process entry accepts exactly one JSON request and returns one
validated envelope. Interactive login and tail retain terminal streaming.
Callers never construct historical Wrangler arguments or parse imitation output.
Pinned `cf` CLI presentation is decoded only at the actual provider boundary.
The old `cf-compat` entry and its argument/flag parser are deleted.

## Preserved behavior

Keep account and endpoint pinning, generated config and lock persistence,
pagination, ownership checks, absent-resource confirmation and fail-closed
malformed responses. Cancellation, process-group termination and lock quarantine
still dominate buffered provider results. Preserve uploader hashes and artifact
verification, active-secret lineage, cutover, trigger publication and rollback.
The matching platform payload stays bundled with `void`. Public CLI syntax,
authentication destinations and Workers Free defaults are unchanged.

## Verification

Run focused protocol, actual subprocess and deployment tests first. Existing
failure and race scenarios replay through test-only adapters; direct typed tests
prove public targets, secret stdin, structured absence and cancellation behavior.
No compatibility adapter remains in production. Verify the rebuilt private
launcher and CLI, affected selection, package typechecking and the final complete
repository gate. Commit this work separately on main without pushing.

Focused protocol, authentication, provisioning, installation and activation
regressions passed, including secret stdin, early pipe closure, nested provider
interruption and cancellation despite buffered not-found codes. Existing lock,
quarantine, ownership, secret-inheritance and rollback scenarios remain covered.
The affected selector conservatively selected the full repository after packaging
and deleted-file changes. Workspace typechecking passed. Final `vpr test:all`
passed formatting, lint, package/platform/playground builds, artifact checks,
platform lint, typechecking and all 641 test files: 11,897 tests passed,
25 skipped. Live provider tests were disabled; no remote platform mutation was
needed for this private transport refactor.
