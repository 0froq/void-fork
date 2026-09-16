---
title: Direct Deployment and Platform Beta Readiness
status: implemented
created: 2026-09-16
---

# Direct Deployment and Platform Beta Readiness

Implement the remaining beta review findings on `main`, starting at `ff4f1a15`.
The user authorized the fixes and one commit per issue. Commit subjects start
with a capital letter and end with a period. Preserve the last-administrator
guard; add no administrator recovery or promotion bypass.

## Work and commit boundaries

- [x] Apply routing rules in native Cloudflare production Workers.
- [x] Share authoritative page cache policy across deployment targets.
- [x] Consolidate the equivalent API prewarm resolver after the Sandbox drain commit.
- [x] Preserve production ownership during readiness fallback and compensation.
- [x] Use supported Durable Object storage for fresh platform installations.
- [x] Recover verified installation records when owned resources are missing.
- [x] Establish durable custody of installation signing and encryption keys.
- [x] Restore a complete rotated project keyring when recreating the API Worker.
- [x] Protect the last active administrator (`ff4f1a15`).
- [x] Correct and verify minimum platform runtime permissions.
- [x] Accept supported JSONC syntax during Cloudflare connection.
- [x] Audit browser administrator mutations alongside operator API changes.
- [x] Attach schema secrets to the candidate deployment before activation.
- [x] Handle or reject later Durable Object lifecycle changes before mutations.
- [x] Keep prerelease publishing and scaffolding on the selected release channel.
- [x] Require platform tests before publishing the packaged runtime.
- [x] Check schema upgrades against an immutable previous runtime and populated data.
- [x] Verify packed public packages outside the workspace using public Vite.
- [x] Pin new projects to the SDK's tested compatibility date instead of today's date.
- [x] Preserve request-binding module identity in installed-package development.
- [x] Define and enforce the supported Node/CLI/platform compatibility contract.
- [x] Support native Cloudflare AI development without a Void login.
- [x] Safely exclude managed Sandboxes, including retained legacy deployments.
- [x] Serialize legacy deployment admission before accepting an empty Sandbox drain inventory.
- [x] Correct browser OAuth/DNS and first Workers-subdomain onboarding.
- [x] Document and verify compatible rollback after a successful platform upgrade.
- [x] Align feature guides, framework support, product wording, quotas, and operations.
- [x] Add local release acceptance coverage and a separate live signoff procedure.
- [x] Run final verification and four GPT-5.6 Sol/high reviews; fix review P1s separately.

The npm and pnpm packed consumer matrices both passed all four frameworks,
including real scaffolding, frozen installs, public Vite builds and TypeScript,
development/preview, Markdown, KV, assets, hydration, and SPA navigation. This
uncovered separately committed compatibility-date, runtime-module identity,
Solid declaration, and pnpm bootstrap fixes. Full source verification passed
442 files / 8,328 tests with 11 skipped tests: six unconfigured live Cloudflare
cases, three unavailable Deno cases, and two PostgreSQL concurrency cases that
passed separately against real PostgreSQL. All 29 workspace typechecks, the
package build, lint, formatting, and docs build passed.

Four independent GPT-5.6 Sol/high reviewers completed the native deployment,
installer, control-plane, and release/package reviews. Their P1 findings were
fixed in separate commits, with an additional independent credential review:

- `0f1a8c6f`: read authoritative Worker script migration metadata for repeat Durable Object deploys.
- `2d190549`: recover abandoned deployment and rollback work during Sandbox drain maintenance.
- `9a67a577`, `f2541df2`, and `8011c1a2`: resume credential updates, reject stale cross-host intent, and preserve encrypted custody of staged values.
- `858aaa49`: serialize legacy deployment admission before accepting an empty drain inventory, and enforce runtime safety protocol 2 after arming.
- `26aa9fe4`: require populated backward-schema verification on tag publishing.

No remaining P1 was reported in the reviewed scopes. Final verification also
caught and corrected a test mock signature and health fixtures that assumed an
empty checkpoint table. No live Cloudflare signoff is claimed.

Root owns integration, commit boundaries, release tooling, installer and operator
follow-ups. The native deployment implementation agent owns compiler/deployment
and cache changes. Shared build outputs are rebuilt serially; focused source tests
may run independently. Completed original findings are not reopened without a
current reproduction.

## Verification and scope

Run focused regression tests during development and `vp run check` after batches.
Before completion, build the distributable packages and platform runtime, test
packed consumer fixtures, run the full test suite, lint, format, and build docs.
Use disposable local PostgreSQL for database concurrency and upgrade scenarios.
Keep normal native apps Workers Free-compatible and preserve native Sandbox use.

No live account mutation, deployment, package publication, or push is implicit in
this code-fix task. Credentialed acceptance must use an explicitly selected
disposable account and reviewed resource plan. Add runnable acceptance tooling
and clearly distinguish local/mocked verification from live evidence.

The beta scope is native Cloudflare applications plus an invitation-controlled
core platform. Optional hosted features must not be advertised as core features.
Managed Sandboxes require explicit legacy draining and activation guards; a
capability flag alone cannot stop tenant-owned containers.

## Release acceptance commands

Build public packages, then test their real tarballs outside the workspace:

```sh
vp run build
node .github/scripts/packed-consumer.mjs
```

The harness uses a read-only loopback registry for the release cohort and public
npm for external dependencies. It drives the actual `create-void`/`void init`
interaction with npm and pnpm, checks frozen reinstalls and public Vite 8, and
exercises React, Vue, Svelte, and Solid builds, typechecking, development,
production preview, KV, assets, hydration, and client navigation. The React
fixture also verifies the separately installed Markdown plugin. Failures retain
bounded console diagnostics and complete command logs in the printed temporary
directory. `VOID_PACKED_PM` and `VOID_PACKED_FRAMEWORK` select focused reruns.

The prior `ff4f1a15` API source and its own built SDK packages were independently
tested against PostgreSQL with the current migrations through `0037`: 46 API
test files and 1,324 tests passed before the admission barrier was armed. The
operator suite separately passed 32 PostgreSQL tests, including both admission
serialization cases. Once the barrier is armed, the runtime safety floor rejects
older code that cannot supply the new admission protocol. These are local
database checks, not live Cloudflare deployment tests.

## Live beta signoff

These checks require a separately selected disposable account, domain, database,
and protected credentials. They are not silently substituted with local mocks:

1. Run the gated native live suite from `packages/void/test/e2e/README.md` on a
   Workers Free account. Add a Pages app and inspect data, logs, routing rules,
   failed-candidate secret rotation, rollback, and an existing-Worker handoff.
2. Run the packaged `platform install --plan`, review its account/resource names,
   then install into an eligible disposable platform account. Complete actual
   GitHub OAuth login and have a second developer connect and deploy an app.
3. Exercise the documented minimal runtime token, R2 upload, D1/KV, queue/cron,
   AI and ISR operations. A health response alone is insufficient evidence.
4. Interrupt and resume installation/upgrade; recover local records on another
   machine; recreate a missing API Worker using the saved complete keyring; and
   verify existing project secrets still decrypt.
5. Verify compatible runtime rollback and roll-forward. For a legacy Sandbox
   installation, verify maintenance login, bounded drain, provider-side container
   termination, and rejection of old unsafe runtimes before restoring traffic.
6. Verify disable/enable and both uninstall retention modes. Review retained
   resources and preserve unrelated account resources.

Record the candidate commit, artifact digest, nonsecret account/resource IDs,
results, and times. Keep actual credentials in the secret manager. No live beta
signoff is claimed by the local test results recorded here.

## Upstream email rebase

The 75 local commits were rebased onto upstream `2bae6708` (email support).
Upstream's `0034_email_destinations` migration remains unchanged. The local
invitation-history, repository-authorization, Sandbox-drain, and admission
migrations now follow it as `0035` through `0038`; their snapshots retain the
email schema and form one ordered predecessor chain. Compatibility digests and
migration tests use the combined history.

Integration checks preserve email's shared project-slug binding and the removal
of tenant Sandbox accounting authority. Generated-Worker tests now use the
upstream compiler options object and WorkerEntrypoint interface, plus the
installed Miniflare 5 compatibility adapter and persistence setting.

The package and playground builds, all 29 workspace typechecks, Drizzle snapshot
checks, and documentation build passed. The final full suite passed 465 files
and 9,641 tests, with 11 skipped tests. A disposable PostgreSQL database also
verified the predecessor API against the combined migrations; its outdated
Sandbox slug expectation was corrected in the temporary test copy and passed
on rerun. No production deployment was performed.
