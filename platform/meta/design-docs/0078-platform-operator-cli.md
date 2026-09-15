---
title: Platform Operator CLI
status: in-progress
created: 2026-09-15
---

# Platform Operator CLI

Extend `void platform` with all supported administrative operations currently
available through the admin dashboard. Use shared server operations for browser
and terminal clients. Keep installation lifecycle management ownership-aware.

## Interface

The JSON API lives at `/operator/v1`. It requires a dedicated bearer token with
audience `operator`, independently of browser admin cookies and application
deployment tokens. `POST /operator/v1/session` explicitly exchanges a full API
session belonging to an active administrator for a one-hour operator token.
Every request checks the current administrator role and suspension state.
Operator credentials live in separate origin-scoped keychain entries;
`VOID_OPERATOR_TOKEN` supplies headless credentials. No implicit credential
fallback to deployment tokens is permitted for administrative operations.

Operator commands select an explicit `--connection <id-or-url>`, an explicit
`VOID_API_URL`, or the active connection. Repository metadata cannot select the
recipient of operator credentials. Existing lifecycle commands remain intact.

Groups: `auth login|logout|status|token`, `user list|show|plan|suspend|restore|delete`,
`project list|show|delete`, `deployment list|show|cancel|logs`, `build show|logs`,
`signup show|open|restrict|allow|remove`, `invitation list|send|revoke`,
`system overview|health|cli-versions|events|backfill-queue-tokens`, and hosted-only
`worker list|show|rollback|rollback-all|events`.

Reads use GET. Mutations use POST with JSON bodies and accept `dryRun: true` for
validation and a concrete preview with no writes. Lists accept bounded `page`
and `limit` values plus supported filters; responses describe pagination.
Errors return `{ error, message }` with meaningful HTTP statuses. Mutations do
not retry automatically; partial outcomes are explicit. Preview responses use
`{ dryRun: true, action, target, ...details }`.

CLI mutations first request a preview, display the selected origin and affected
objects, and require confirmation unless `--yes` was explicitly supplied.
`--plan` exits after preview. Noninteractive invocations without `--yes` or
`--plan` fail before mutation. `--json` writes structured results to stdout;
diagnostics go to stderr. IDs/path segments and query values are encoded.

## Implementation and commits

- [x] Authentication, JSON errors/validation, mutation audit, API registration.
- [x] Shared user/project/access operations and tenant API with regression tests.
- [x] Shared deployment/build/system/hosted-worker operations and regression tests.
- [x] CLI parsing, transport, origin-scoped auth, output, previews and log following.
- [x] Help, interactive hints, public documentation, package READMEs and agent guidance.
- [ ] Package builds, typechecking, final full test suite and CLI smoke verification.
- [ ] Four GPT-6 Astra high reviews, GPT-5.6 Sol high fixes committed individually,
      and repeated review until no P1 findings remain.

Commit subjects start with a capital letter and end with a period. The user has
explicitly authorized these commits. No deployment or push is part of this task.

## Verification

Run relevant `vp test run` selections during each feature batch and `vp run check`
after batches. Investigate hanging or unusually slow tests immediately. At final
verification run the full test suite, build the distributable CLI/runtime, and
exercise the real CLI against a local API test fixture. Cover credential audience
separation, role revocation, origin selection, JSON failures, malformed arguments,
dry runs without writes, mutation partial failures, log cursors and hosted-only
guards before external calls. Preserve admin browser behavior and native
Cloudflare Free compatibility. Update `README.md`, affected package READMEs,
`docs/reference/cli.md`, the self-hosted guide, `packages/void/skills/void`,
`packages/void/AGENT_PROMPT.md`, and `packages/void/getting-started-prompt.txt`.
