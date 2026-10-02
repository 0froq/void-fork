# Void Platform

The Void platform runs in your Cloudflare account and lets developers deploy
applications through the Void CLI. This repository contains its control plane,
routing, proxy, log ingestion, and optional dashboard and build services.

The API, dispatch, proxy, tail, and email gateway Workers are packaged into
[`@void/platform`](../packages/platform/README.md). A released or source-built
runtime can be installed and upgraded with `void platform`. The installer tracks
resource ownership, applies compatible migrations, and preserves credentials
across upgrades.

Start with [Self-host a Void Platform](../docs/guide/self-hosted-platform.md) to
install it, [Platform Administration](../docs/guide/platform-administration.md) to
operate it, or [Platform Development](../docs/guide/platform-development.md) to
work on a fork. The dashboard and managed builds are optional source components;
they are not provisioned by the core installer.

Commands below run from the repository root. Package paths in the tables are
relative to `platform/` unless they begin with `../`.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- Read the [architecture](./meta/architecture.md) for the current component map.
- Use the [maintainer documentation index](./meta/README.md) and [design archive](./meta/design-docs/README.md) for implementation context. Archived plans are not a current roadmap.
- Public SDK: repository-level `packages/`. If work involves the SDK, read the root `AGENTS.md` and the affected package instructions first.
- Public-facing docs: repository-level `docs/` (VitePress site).

## Contributor guidance

- Read [the operating lessons](./meta/lessons.md) before changing the platform.
- **Never** commit without asking for confirmation.
- Keep technical design records in `meta/design-docs/`, following its naming and
  frontmatter conventions. Keep commercial strategy, pricing research,
  competitor analysis, and private operational inventories out of the repository.
- Follow the root [instructions](../AGENTS.md) and
  [testing guide](../TESTING.md) for verification. Update the affected package
  guide when its behavior or contributor workflow changes.

## Quick Reference

| Command                                      | Purpose                                                   |
| -------------------------------------------- | --------------------------------------------------------- |
| `vp run build:core`                          | Build shared packages, CLI, and packaged platform runtime |
| `vp run build:platform`                      | Build the platform source apps                            |
| `vp run --filter @voidcloud/platform dev`    | Start the dashboard development server                    |
| `vp run build:all`                           | Build all packages, platform apps, and playgrounds        |
| `vp test run --project 'platform-*'`         | Run platform tests                                        |
| `vp run lint:platform`                       | Run type-aware platform lint                              |
| `vp run check`                               | Typecheck the workspace                                   |
| `vp run test:all`                            | Format check, lint, build, typecheck, and test            |
| `vp run --filter @voidcloud/platform health` | Check the selected platform using operator authentication |

The workspace `dev` and `build` scripts in `platform/package.json` apply to the
dashboard. They do not start the API or install a platform. Deployment scripts
in that file serve the existing Void Cloud deployment; see [operations](#operations).

## Operator CLI

Sign in as an administrator to inspect users, projects, deployments, and platform
health:

```sh
void platform auth login
void platform user list
void platform system health
```

Commands use the selected platform connection. Add `--plan` to preview a change,
`--yes` to apply it in a script, and `--json` to read structured results. The
[Platform Administration guide](../docs/guide/platform-administration.md) covers
the workflows; the [CLI reference](../docs/reference/cli/platform.md#operator-commands)
lists all commands and options.

The CLI and browser admin UI share the same server operations and record their
mutations in `operator_events`. The operator API is served at `/operator/v1`. Apply
`0033_operator_sessions_and_events` before deploying the API; the migration adds
tables and indexes that remain compatible with existing Workers.

Both interfaces prevent deletion or suspension of the last active administrator.
Allowed administrator removals revoke access before resource cleanup and preserve
that revocation if cleanup fails, so concurrent removals cannot lock out the
remaining administrator.

Administrators can manage installation plans from **Plans** in `/admin/` or
`void platform config plans`. Both interfaces review changes before applying
them and let you resume pending account updates. See
[Plans and Limits](../docs/guide/platform/administration/plans.md).

When upgrading an installation that previously enabled managed Sandbox, run
`void platform system sandbox-drain --plan`, then apply it and rerun until it
reports `complete: true`. Preview later bounded pages by passing the returned
`nextCursor` to `--cursor`. The lifecycle installer keeps application traffic
closed while this database-backed drain is required. An active deployment is
first asked to cancel; rerun the drain after 10 minutes if its request was
abandoned. A protected cutover remains fenced for 90 minutes before the drain
can compensate it, while an interrupted rollback is adopted through its
database lease. These retries restore the committed deployment before deleting
the managed Sandbox container.

Project state upgrades use `0054_project_mode` to normalize the old `worker` mode
and default to `void`. Before rolling out this runtime, finish any protected
cutover or rollback recovery whose project has no active deployment pointer on
the previous compatible runtime. Recovery remains fenced when that identity is
missing. After rollout, `void platform project normalize <id> --plan` verifies
the serving route and recorded queue names; `--yes` applies only the previewed
PostgreSQL repairs. It does not choose the newest historical deployment or write
routing/provider state. Existing active pointers are preserved. A verified queue
name that differs from the expected delivery routing name blocks normalization
until its queue routing is reconciled.

## Local Development

With a local PostgreSQL server running, build the shared packages and set up the API:

```sh
vp run build:core
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev --local --enable-containers=false --host localhost --port 8787
```

Open `http://localhost:8787/admin/`. To work on the dashboard, start it separately:

```sh
vp run --filter @voidcloud/dashboard dev
```

The [development guide](../docs/guide/platform-development.md) explains the local
configuration, fork CI, schema changes, and how to deploy a source-built runtime
into your own installation.

## Monorepo structure

Void is one repository with an explicit dependency boundary:

- Repository-level `packages/` — public SDK, CLI, runtime helpers, and framework adapters.
- `../packages/deploy-core` — target-neutral deployment manifests and wire contracts shared by the SDK and platform.
- `../packages/platform` — public deployment/installation manifests plus integrity-checked core Worker artifacts used by the platform installer.
- `platform/packages/` — platform implementation packages for the control plane, routing, proxy, logs, dashboard, and UI.
- Platform packages may depend on public/shared packages. Public SDK packages must not depend on `platform/`.

### Top-Level Map

| Path                                                           | Purpose                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`packages/api`](./packages/api/README.md)                     | Control plane API, deploy pipeline, provisioning, administrator UI        |
| [`packages/dashboard`](./packages/dashboard/README.md)         | User-facing dashboard app                                                 |
| [`packages/dispatch`](./packages/dispatch/README.md)           | Edge router for installation app domains and custom domains               |
| [`packages/email-gateway`](./packages/email-gateway/README.md) | Email ingress, bounded tenant delivery, and validated email actions       |
| [`packages/proxy`](./packages/proxy/README.md)                 | AI proxy, remote D1/KV/R2 proxy, ISR revalidation bridge                  |
| [`packages/tail`](./packages/tail/README.md)                   | Runtime log ingestion into Analytics Engine                               |
| [`../packages/void`](../packages/void/AGENTS.md)               | Main `void` package: Vite plugin, CLI, runtime, codegen, deploy packaging |
| `../packages/{vue,react,svelte,solid}`                         | Pages-mode adapters and runtime helpers                                   |
| `../packages/create-void`                                      | Scaffolding package                                                       |
| `../packages/md`                                               | Markdown package                                                          |
| `../docs`                                                      | Public-facing SDK docs                                                    |
| `meta/design-docs`                                             | Historical design archive                                                 |
| `meta/operations.md`                                           | Operations/runbook                                                        |

The dashboard consumes built `void` and `@void/react` workspace packages. Run
`vp run build` before deploying it from a fresh checkout.

## SDK guidance

Public SDK architecture and adapter guidance live in the
[root instructions](../AGENTS.md) and
[core package instructions](../packages/void/AGENTS.md).
Use the [framework integration guide](../docs/integrations/frameworks/overview.md)
for the supported framework list.

The package READMEs above describe each component's implementation and tests.
Use [the architecture guide](./meta/architecture.md) for the runtime and data-flow
map, and [the development guide](../docs/guide/platform-development.md) for local
setup and source deployments.

## Tooling

Use the versions declared in `.node-version`, `pnpm-workspace.yaml`, and package
manifests. Vite+ supplies the build, test, lint, format, and package commands;
platform Workers run through the checked-in development scripts. PostgreSQL is
used for platform metadata and reached through Hyperdrive in deployed Workers.

## Testing

Tests run from root with `vp test run`. See each package README for detailed test listings.

## Operations

For an installed platform, use `void platform` lifecycle and administrator
commands. `vp run --filter @voidcloud/platform health` forwards to
`void platform system health`, using the selected connection and operator login.
Automation supplies `VOID_OPERATOR_TOKEN` and an explicit `VOID_API_URL`.

Void Cloud maintains an existing deployment that predates the installer. Its
`platform/package.json` deployment scripts and `platform/deployments/void-cloud.json`
descriptor belong to that deployment. The [Void Cloud operations note](./meta/operations.md)
explains its environments and credentials without storing account-specific
inventories or personal access assignments in the repository.

The hosted deploy/smoke workflows target the existing Void Cloud deployment.
Forks build their own runtime and use `void platform install` or
`void platform upgrade --runtime`, as shown in the development guide.

## Implementation Notes

- Platform metadata uses PostgreSQL through Hyperdrive. Application databases
  still default to D1 unless an app selects PostgreSQL or MySQL.
- Keep Worker TypeScript libraries explicit. DOM globals can hide the Workers
  types, including `CacheStorage.default`.
- Deploy protocol and database changes must tolerate the previous Worker version
  during rollout. Use additive migrations and verified compatibility edges.
- Static applications are served from platform assets. Worker applications also
  mirror assets in KV/R2 so dispatch can recover from the Cloudflare missing-asset
  response; see the [fallback design](./meta/design-docs/0066-wfp-asset-r2-fallback.md).
- Keep routing changes, cron synchronization, and resource cleanup ordered around
  the successful deployment cutover. A pre-cutover failure must preserve the
  previous application's active configuration.
- Build subprocesses need `CI=true` so terminal prompts and animations do not
  interfere with captured output. Preserve raw logs for terminal consumers and
  sanitize them when rendering HTML or Markdown.
- Only Durable Object storage operations hold its input gate. Network I/O can
  interleave with cancellation and polling; shared log drains and teardown must
  keep their existing single-flight ordering.
- Bound retries and log processing by both time and input size. A timeout on a
  wait does not cancel the underlying database operation, and a row-count limit
  alone does not bound payload bytes or processing work.
- Drain build logs before publishing completion. Cancellation must preserve the
  authoritative final marker even when another handler has already changed the
  build's status. See the build-manager regression tests.
- GitHub build reruns require `check_run` and `check_suite` webhook subscriptions
  in addition to Checks write permission. Reuse the same ownership, branch-head,
  and deduplication checks as push-triggered builds.
- The fallback build-container CLI version is derived from the SDK package
  version. The version equality test enforces this during updates.

The [lessons](./meta/lessons.md) and affected package tests contain more detailed
invariants. The [design archive](./meta/design-docs/README.md) explains historical
tradeoffs without acting as a live deployment runbook.
