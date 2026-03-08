## Repo setup

This is the private platform repo for Void. The open-source framework code lives in `framework/` (git submodule pointing at `voidzero-dev/void`).

If all changes are inside `framework/`, commit only in `framework/`. Do not create a platform commit just to bump the submodule pointer.

When changes span both repos, commit framework first, then update the submodule pointer in the platform repo:

```bash
# 1. commit framework changes
cd framework
git add . && git commit -m "feat: whatever"

# 2. update submodule pointer + commit platform changes
cd ..
git add framework  # updates the pointer to the new framework commit
git add ...        # any platform changes
git commit -m "feat: whatever (bump framework)"
```

**When working in worktrees:** Commits made in a worktree's `framework/` submodule can be cherry-picked back to the main worktree. Submodules in separate worktrees have separate object stores, so you must fetch before cherry-picking. Cherry-pick also produces new SHAs (same content, different hash), so the platform commit's submodule pointer must be amended afterward.

```bash
# 1. fetch objects from the worktree's submodule (separate object stores — SHA won't be found without this)
cd /path/to/main/framework
git fetch /path/to/worktree/framework HEAD

# 2. cherry-pick framework commit(s)
git cherry-pick <framework-sha>

# 3. if there was also a platform commit, cherry-pick it
cd /path/to/main
git cherry-pick <platform-sha>

# 4. if you cherry-picked a platform commit that referenced framework,
#    fix the submodule pointer — cherry-pick gave the framework commit a new SHA,
#    but the platform commit still references the worktree's original SHA
git add framework
git commit --amend --no-edit

# 5. verify — no '+' prefix means the pointer matches
git submodule status
```

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- Refer to the [Design Doc](./meta/design-docs/0001-design.md) for the high-level vision and architecture.
- Refer to the [Progress Doc](./meta/progress.md) for tracking progress.
- Framework repo: `framework/` (git submodule — run `git submodule update --init` after cloning). If work involves the framework, read `framework/CLAUDE.md` first.
- Public-facing docs: `framework/docs` (Vitepress site).

## Best Practices That Must Be Followed

1. General

- **Always** read `meta/lessons.md` at the start of each session before taking any action.
- **Never** commit without asking for confirmation.
- When writing design docs or implementation plans to disk, place them in `meta/design-docs` and follow existing file name and frontmatter conventions.
- When adding new dependencies to the project, always run `npm view [package] version` to get the latest version.

2. Subagent Strategy
   - Use subagents liberally to keep the main context window clean.
   - Offload research, exploration, and parallel analysis to subagents.
   - For complex problems, allocate more compute via subagents.
   - Assign one task per subagent to ensure focused execution.

3. Self-Improvement Loop
   - After any correction from the user, update meta/lessons.md with the relevant pattern.
   - Create rules for yourself that prevent repeating the same mistake.
   - Iterate on these lessons rigorously until the mistake rate declines.

4. Principles
   - Simplicity First: Make every change as simple as possible. Minimize code impact.
   - No Laziness: Identify root causes. Avoid temporary fixes. Apply senior developer standards.
   - Minimal Impact: Touch only what is necessary. Avoid introducing new bugs.
   - For non-trivial changes, pause and ask whether there is a more elegant solution.
   - If a fix feels hacky, implement the solution you would choose knowing everything you now know.
   - Do not over-engineer simple or obvious fixes.
   - Critically evaluate your own work before presenting it.

5. Planning
   - Enter plan mode for any non-trivial task (three or more steps, or involving architectural decisions).
   - If something goes wrong, stop and re-plan immediately rather than continuing blindly.
   - Every implementation plan should include the following:
   - During plan generation: ask clarifying questions when necessary, especially around developer-experience defining design decisions.
   - Verification:
     - Run `pnpm check` for typecheck after completing a batch of tasks.
     - Run `pnpm test` on tests relevant to the current feature only during feature development. Only run the full test suite when everything is done for final verification.
     - If there are tests hanging or running particularly slow, investigate right there and attempt to fix. Testing velocity is something that should be maintained or improved at every opportunity.
   - Documentation: after verification, update all docs if relevant and applicable:
     - `README.md` (this file)
     - affected packages's `README.md` or `AGENTS.md`
   - Progress tracking: tick off relevant steps in `meta/progress.md` when applicable.

## Quick Reference

| Command                             | Purpose                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Start the dashboard dev server only                                                                 |
| `pnpm build`                        | Build the dashboard only                                                                            |
| `pnpm test`                         | Run vitest (unit + integration tests)                                                               |
| `pnpm lint`                         | Run oxlint                                                                                          |
| `pnpm fmt`                          | Run oxfmt                                                                                           |
| `pnpm check`                        | Run package `typecheck` scripts (`tsgo --noEmit` in most packages, `vue-tsc --noEmit` in dashboard) |
| `pnpm run deploy`                   | Deploy `proxy` → `tail` → `api` → `dispatch`                                                        |
| `pnpm run deploy:dashboard`         | Deploy the dashboard separately                                                                     |
| `pnpm run deploy:staging`           | Deploy staging `proxy` → `tail` → `api` → `dispatch`                                                |
| `pnpm run deploy:staging:dashboard` | Deploy the staging dashboard separately                                                             |

Root `dev` and `build` are intentionally dashboard-only. Dashboard work is currently deferred, which is why it stays outside the main platform deploy pipeline.

**Manual deploys only. Do not ask to push or deploy.**

## Monorepo Structure

Void is split across two codebases in this repo:

- `packages/` — the private platform: control plane, traffic router, proxy services, log pipeline, dashboard, and shared internal UI styles
- `framework/` — the open-source framework submodule: Vite plugin, CLI, runtime helpers, adapters, docs, and tests

### Top-Level Map

| Path                                                   | Purpose                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`packages/api`](./packages/api/README.md)             | Control plane API, deploy pipeline, provisioning, internal admin UI       |
| [`packages/dashboard`](./packages/dashboard/README.md) | User-facing dashboard app                                                 |
| [`packages/dispatch`](./packages/dispatch/README.md)   | Edge router for `*.void.app` and custom domains                           |
| [`packages/proxy`](./packages/proxy/README.md)         | AI proxy, remote D1/KV/R2 proxy, ISR revalidation bridge                  |
| [`packages/tail`](./packages/tail/README.md)           | Runtime log ingestion and live tail streaming                             |
| [`packages/ui`](./packages/ui)                         | Shared internal CSS tokens                                                |
| `framework/packages/void`                              | Main `void` package: Vite plugin, CLI, runtime, codegen, deploy packaging |
| `framework/packages/{vue,react,svelte,solid}`          | Pages-mode adapters and runtime helpers                                   |
| `framework/packages/create-void`                       | Scaffolding package                                                       |
| `framework/packages/md`                                | Markdown package                                                          |
| `framework/docs`                                       | Public-facing framework docs                                              |
| `meta/design-docs`                                     | Internal design history                                                   |
| `meta/progress.md`                                     | Progress tracker                                                          |
| `meta/operations.md`                                   | Operations/runbook                                                        |

### Where Code for X Lives

| Feature                                                                   | Primary code paths                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite plugin and local runtime                                             | `framework/packages/void/src/index.ts`, `plugin-*`, `runtime/*`                                                                                   |
| CLI commands                                                              | `framework/packages/void/src/cli/*`                                                                                                               |
| File-based API routing                                                    | `framework/packages/void/src/router/*`, `runtime/handler.ts`                                                                                      |
| Pages routing, loaders, actions, named actions, deferred props            | `framework/packages/void/src/pages/*`, adapter runtimes in `framework/packages/{vue,react,svelte,solid}/src/runtime/*`                            |
| Typed route/page/action codegen                                           | `framework/packages/void/src/codegen/*`, `routes-stub.ts`                                                                                         |
| Binding inference                                                         | `framework/packages/void/src/plugin-inference.ts`, `framework/packages/void/src/inference/*`                                                      |
| Drizzle integration and migrations                                        | `framework/packages/void/src/drizzle/*`, `framework/packages/void/src/migrations/*`                                                               |
| Framework detection and deploy presets                                    | `framework/packages/void/src/plugin-inference.ts`, `framework/packages/void/src/cli/preset.ts`                                                    |
| Platform auth and project APIs                                            | `packages/api/src/routes/*`, `packages/api/src/auth/*`, `packages/api/src/middleware/*`                                                           |
| Internal admin UI                                                         | `packages/api/src/admin/*`                                                                                                                        |
| Deploy pipeline                                                           | `framework/packages/void/src/cli/deploy.ts`, `packages/api/src/routes/deploy.ts`, `packages/api/src/assets.ts`, `packages/api/src/provisioning/*` |
| Hostname routing, static serving, ISR, redirects, headers, metering       | `packages/dispatch/src/*`                                                                                                                         |
| AI metering, BYOK AI gateway, remote D1/KV/R2 access, revalidation bridge | `packages/proxy/src/*`                                                                                                                            |
| Runtime logs and live tailing                                             | `packages/tail/src/index.ts`, `packages/api/src/admin/routes/deployments.tsx`                                                                     |
| User-facing dashboard                                                     | `packages/dashboard/pages/*`, `packages/dashboard/middleware/01.auth.ts`, `packages/dashboard/lib/api.ts`                                         |
| Shared internal styling                                                   | `packages/ui/src/base.css`, `packages/ui/src/theme.css`                                                                                           |

The dashboard depends on `void` and `@void-x/vue`, resolved via `pnpm.overrides` to `link:framework/...` (the git submodule). CI checks out the submodule and builds it before `pnpm install`.

## Framework Repo Overview

The framework submodule is the public product surface.

### `framework/packages/void`

This is the main `void` package.

- `src/index.ts` wires together routing, pages-mode infrastructure, codegen, migrations, prerendering, Cloudflare integration, and non-CF targets.
- `src/cli/*` contains the CLI.
- `src/router/*` handles `routes/` scanning and route compilation.
- `src/pages/*` handles pages-mode scanning, protocol, head management, defer, and manifest generation.
- `src/runtime/*` contains helpers exposed as `void/db`, `void/kv`, `void/storage`, `void/ai`, `void/isr`, `void/client`, and auth utilities.
- `src/codegen/*` generates `.void/routes.d.ts`, `.void/db.d.ts`, `.void/queues.d.ts`, and tsconfig glue.
- `src/drizzle/*` and `src/migrations/*` handle schema discovery and migration execution.
- `src/plugin-node-target.ts` supports `target: "node" | "bun" | "deno"`.

### Adapter packages

- `framework/packages/vue`
- `framework/packages/react`
- `framework/packages/svelte`
- `framework/packages/solid`

These packages provide pages-mode adapters, links, forms, router helpers, prefetching, and framework-specific client behavior.

### Framework support

Current public support is:

- TanStack Start
- React Router
- SvelteKit
- Nuxt
- Astro

There is Vinext-specific source in the framework repo, but it is intentionally on hold and not part of the current public support matrix.

## Platform Package Overview

### `packages/api`

The control plane.

- Owns users, OAuth accounts, projects, deployments, resources, domains, and platform events.
- Stores platform metadata in PostgreSQL via Hyperdrive.
- Exposes the API used by the CLI and dashboard.
- Runs deploys, rollbacks, provisioning, routing updates, queue setup, and retention cleanup.
- Also contains the internal admin UI in `src/admin/`.

### `packages/dashboard`

The user-facing dashboard.

- Built as a Void Vue pages app.
- Uses direct Postgres reads through Hyperdrive for read-heavy loaders.
- Uses the API for mutations, usage metrics, secrets, and domain operations.
- Is deployed separately from the main platform pipeline.
- Is currently de-emphasized relative to the rest of the platform work.

### `packages/dispatch`

The edge router.

- Reads slug/domain routing from KV.
- Sends worker projects to Workers for Platforms.
- Serves static/SPA deployments directly from `STATIC_ASSETS` KV with R2 overflow for large files.
- Handles ISR, edge caching, redirect rules, header rules, and request metering.
- Relays Cloudflare Queue batches to user workers.

### `packages/proxy`

The shared proxy layer.

- Routes all AI traffic through AI Gateway for metering.
- Supports BYOK provider models in addition to Workers AI.
- Provides authenticated remote D1/KV/R2 access for local development.
- Forwards ISR revalidation requests from user workers to the API.

### `packages/tail`

The runtime log pipeline.

- Receives tail events from dispatch/user workers.
- Writes logs to Analytics Engine.
- Broadcasts live log events through a Durable Object.

## Tooling

| Tool     | Version       | Purpose                                                                                        |
| -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Node.js  | 24.13.1       | Runtime (TS type stripping enabled natively — no `tsx` or `--experimental-strip-types` needed) |
| pnpm     | 10.x          | Package manager with workspaces + catalog                                                      |
| wrangler | 4.x           | CF Worker dev/deploy (api, dispatch)                                                           |
| drizzle  | 0.45.x        | Type-safe ORM for API PostgreSQL (schema + queries + migrations)                               |
| vitest   | 4.x           | Unit + integration tests                                                                       |
| oxlint   | 1.47.x        | Linting                                                                                        |
| oxfmt    | 0.32.x        | Formatting (double quotes, semis)                                                              |
| vite     | 8.0.0-beta.14 | Dev server + build (dashboard)                                                                 |

## Testing

Tests run from root with `pnpm test` (vitest). See each package README for detailed test listings.

## Operations

There are five deployable platform packages/surfaces:

| Package              | Worker / Surface                                | Role                                           |
| -------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `packages/proxy`     | `proxy.void.cloud` / `proxy.staging.void.cloud` | AI proxy, remote bindings, revalidation bridge |
| `packages/tail`      | internal worker                                 | Worker log ingestion and live tail             |
| `packages/api`       | `api.void.cloud` / `api.staging.void.cloud`     | Control plane API and internal admin UI        |
| `packages/dashboard` | `dash.void.cloud` / `dash.staging.void.cloud`   | User-facing dashboard                          |
| `packages/dispatch`  | `*.void.app` / `*.staging.void.app`             | User traffic router                            |

Dashboard deployment is intentionally separate from the main platform pipeline.

```
pnpm run deploy                     # proxy -> tail -> api -> dispatch
pnpm run deploy:dashboard           # dashboard only
pnpm run deploy:staging             # staging proxy -> tail -> api -> dispatch
pnpm run deploy:staging:dashboard   # staging dashboard only
```

See [`meta/operations.md`](./meta/operations.md) for the full operations reference — CF resources, secrets, environment variables, DNS setup, GitHub Actions, and fresh environment provisioning.

## Pitfalls / Things That Broke

- **Platform DB is PostgreSQL; user apps still default to D1** — Platform metadata lives in PostgreSQL via Hyperdrive (`packages/api/src/schema.ts` is the source of truth). User projects still default to D1 unless the app opts into `"database": "pg"`.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `dispatch`. Not applied to `api` (its tests use Miniflare/Node which needs DOM-compatible `URL` types).
- **Deploy protocol and schema changes must stay backward compatible** — deploy manifests are versioned, and schema changes must tolerate old code briefly running against the new schema during deploy. Safe: additive changes. Unsafe without a two-phase rollout: renames, drops, and type changes.
- **Project type field is `mode` in DB, `type` everywhere else** — The `projects` table column is `mode` (DB column name), but the Drizzle schema field and all TypeScript code use `type` (`type: text("mode")`). The `DeployManifest` field is `type`, the API function is `updateProjectType`, and all views/templates reference `project.type`. Values: `"void"` (Void apps), `"spa"`, `"static"`, `"framework"` (3rd-party meta-frameworks like Astro/SvelteKit).
- **Static deployments use KV/R2, not WfP** — Projects with type `"static"` or `"spa"` are served directly by dispatch from content-addressed KV/R2 assets. No WfP worker script is created for those deploys.
