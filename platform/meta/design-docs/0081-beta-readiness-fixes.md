---
title: Direct Deployment and Platform Beta Readiness
status: in-progress
created: 2026-09-16
---

# Direct Deployment and Platform Beta Readiness

Implement the remaining beta review findings on `main`, starting at `ff4f1a15`.
The user authorized the fixes and one commit per issue. Commit subjects start
with a capital letter and end with a period. Preserve the last-administrator
guard; add no administrator recovery or promotion bypass.

## Work and commit boundaries

- [ ] Apply routing rules in native Cloudflare production Workers.
- [ ] Share authoritative page cache policy across deployment targets.
- [ ] Preserve production ownership during readiness fallback and compensation.
- [x] Use supported Durable Object storage for fresh platform installations.
- [x] Recover verified installation records when owned resources are missing.
- [ ] Establish durable custody of installation signing and encryption keys.
- [x] Protect the last active administrator (`ff4f1a15`).
- [ ] Correct and verify minimum platform runtime permissions.
- [ ] Accept supported JSONC syntax during Cloudflare connection.
- [ ] Audit browser administrator mutations alongside operator API changes.
- [ ] Attach schema secrets to the candidate deployment before activation.
- [ ] Handle or reject later Durable Object lifecycle changes before mutations.
- [x] Keep prerelease publishing and scaffolding on the selected release channel.
- [x] Require platform tests before publishing the packaged runtime.
- [ ] Check schema upgrades against an immutable previous runtime and populated data.
- [ ] Verify packed public packages outside the workspace using public Vite.
- [ ] Define and enforce the supported Node/CLI/platform compatibility contract.
- [ ] Support native Cloudflare AI development without a Void login.
- [ ] Safely exclude managed Sandboxes, including retained legacy deployments.
- [ ] Correct browser OAuth/DNS and first Workers-subdomain onboarding.
- [ ] Document and verify compatible rollback after a successful platform upgrade.
- [ ] Align feature guides, framework support, product wording, quotas, and operations.
- [ ] Add release acceptance coverage for cross-target behavior and platform lifecycle.
- [ ] Run final verification and four GPT-5.6 Sol/high reviews; fix review P1s separately.

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
