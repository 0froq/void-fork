## Repo setup

This is the private platform repo for Void. The open-source framework code lives in `framework/` (git submodule pointing at `voidzero-dev/void`).

When making changes that span both repos, commit framework first, then update the submodule pointer in the platform repo:

```bash
# 1. commit and push framework changes
cd framework
git add . && git commit -m "feat: whatever" && git push

# 2. update submodule pointer + commit platform changes
cd ..
git add framework  # updates the pointer to the new framework commit
git add ...        # any platform changes
git commit -m "feat: whatever (bump framework)"
```

For PRs that span both repos: merge the framework PR first, then update the submodule pointer in the platform PR so CI picks up the merged framework changes.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- Refer to the [Design Doc](./meta/design-docs/0001-design.md) for the high-level vision and architecture.
- Refer to the [Progress Doc](./meta/progress.md) for tracking progress.
- Framework repo: `framework/` (git submodule — run `git submodule update --init` after cloning)

## Best Practices That Must Be Followed

- **Never** commit without asking for confirmation.
- When writing design docs or implementation plans to disk, place them in `meta/design-docs` and follow existing file name and frontmatter conventions.
- When adding new dependencies to the project, always run `npm view [package] version` to get the latest version.
- Every implementation plan should include the following:
  - During plan generation: ask clarifying questions when necessary, especially around developer-experience defining design decisions.
  - Verification: run `pnpm lint`, `pnpm fmt`, and `pnpm check`.
    - Fix lint warnings too, not just errors.
    - Run `pnpm test` on tests relevant to the current feature only during feature development. Only run the full test suite when everything is done for final verification.
    - If there are tests hanging or running particularly slow, investigate right there and attempt to fix. Testing velocity is something that should be maintained or improved at every opportunity.
  - Documentation: after verification, update all docs if relevant and applicable:
    - `README.md` (this file)
    - affected packages's `README.md` or `AGENTS.md`
  - Progress tracking: tick off relevant steps in `meta/progress.md` when applicable.

## Quick Reference

```
pnpm -r build                       # Build all packages
pnpm test                           # Run vitest (unit + integration tests)
pnpm lint                           # oxlint
pnpm fmt                            # oxfmt --write .
pnpm check                          # Typecheck all packages (tsc --noEmit)
pnpm run deploy                     # Build all + deploy ai-proxy, dispatch, api & dashboard (production)
pnpm run deploy:staging             # Deploy all workers to staging environment
```

**Manual deploys only. Do not ask to push or deploy.**

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (@cloudflare/workers-types, wrangler). Make sure to run `pnpm install` after making package structure changes.

| Package                                                | npm name                         | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------- |
| [`packages/api`](./packages/api/README.md)             | `@voidcloud/api` (private)       | Control Plane API + Admin Dashboard                            |
| [`packages/dispatch`](./packages/dispatch/README.md)   | `@voidcloud/dispatch` (private)  | Routes `*.void.app` to user workers + R2 assets                |
| [`packages/ai-proxy`](./packages/ai-proxy/README.md)   | `@voidcloud/ai-proxy` (private)  | AI inference proxy — metered Workers AI via AI Gateway         |
| [`packages/dashboard`](./packages/dashboard/README.md) | `@voidcloud/dashboard` (private) | User-facing dashboard — project management, deployments, usage |
| [`packages/ui`](./packages/ui)                         | `@voidcloud/ui` (private)        | Shared CSS/design tokens (used by dashboard)                   |

The dashboard depends on `void` and `@voidcloud/vue`, resolved via `pnpm.overrides` to `link:framework/...` (the git submodule). CI checks out the submodule and builds it before `pnpm install`.

## `dashboard` Overview

Vue Pages mode app serving the user-facing Void dashboard at `dash.void.cloud`. Built with `@voidcloud/vue` (SSR + `<script server>` blocks), Hono, and Tailwind CSS v4 with shared design tokens from `@voidcloud/ui`. Uses a BFF pattern — server-side loaders call the API with the user's JWT (stored in an httpOnly cookie), so the client never talks to the API directly.

- **Auth**: OAuth (GitHub/Google) via API, JWT in httpOnly `void_token` cookie
- **Pages**: login, project list with aggregate usage, project detail (deployments, domains, secrets, usage metrics), settings
- **Deployment**: CF Worker — production at `dash.void.cloud`, staging at `dash.staging.void.cloud`

See [`packages/dashboard/README.md`](./packages/dashboard/README.md) for details.

## `api` Overview

CF Worker serving the Control Plane API + Admin Dashboard. Handles OAuth (GitHub/Google), project CRUD, deploy pipeline (migrations → assets → worker upload), usage metering via Analytics Engine, and plan tier enforcement. Admin dashboard uses Hono JSX with cookie-based auth. Uses Drizzle ORM with D1 for type-safe database queries — schema defined in `src/schema.ts`, types inferred via `InferSelectModel`.

See [`packages/api/README.md`](./packages/api/README.md) for API endpoints, auth flow, deploy flow, tiers, secrets, and CF API token permissions.

## `ai-proxy` Overview

CF Worker proxying all Workers AI inference for metered billing. User workers never receive the `AI` binding directly — all calls route through this proxy, which injects AI Gateway metadata (`projectId`) for tamper-proof token counting and cost tracking. Two auth paths: service binding (production, trusted) and HTTPS with JWT (local dev).

See [`packages/ai-proxy/README.md`](./packages/ai-proxy/README.md) for request format, authentication, and deployment.

## `dispatch` Overview

CF Worker routing `*.void.app` traffic. Extracts slug from hostname → KV lookup → serves API routes via Workers for Platforms (with custom CPU/subrequest limits) or static assets from R2 (with edge caching). Records every request to Analytics Engine for usage metering. Also relays Cloudflare Queue batches to user workers via KV-based routing.

See [`packages/dispatch/README.md`](./packages/dispatch/README.md) for request flow, metering schema, and edge caching strategy.

## Tooling

| Tool     | Version       | Purpose                                                                                        |
| -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Node.js  | 24.13.1       | Runtime (TS type stripping enabled natively — no `tsx` or `--experimental-strip-types` needed) |
| pnpm     | 10.x          | Package manager with workspaces + catalog                                                      |
| wrangler | 4.x           | CF Worker dev/deploy (api, dispatch)                                                           |
| drizzle  | 0.45.x        | Type-safe ORM for API D1 (schema + queries + migrations)                                       |
| vitest   | 4.x           | Unit + integration tests                                                                       |
| oxlint   | 1.47.x        | Linting                                                                                        |
| oxfmt    | 0.32.x        | Formatting (double quotes, semis)                                                              |
| vite     | 8.0.0-beta.14 | Dev server + build (dashboard)                                                                 |

## Testing

Tests run from root with `pnpm test` (vitest). See each package README for detailed test listings.

## Operations

Four workers: `void-api`, `void-dashboard`, `void-dispatch`, `void-ai-proxy`. Two environments: **production** (`api.void.cloud`, `dash.void.cloud`, `*.void.app`) and **staging** (`api.staging.void.cloud`, `dash.staging.void.cloud`, `*.staging.void.app`). Each has fully isolated CF resources (D1, KV, R2, dispatch namespace, analytics engine).

```
pnpm run deploy           # Production
pnpm run deploy:staging   # Staging
```

See [`meta/operations.md`](./meta/operations.md) for the full operations reference — CF resources, secrets, environment variables, DNS setup, GitHub Actions, and fresh environment provisioning.

## Pitfalls / Things That Broke

- **API DB uses Drizzle ORM** — schema is the source of truth in `src/schema.ts`. To add columns or tables: update schema → `pnpm db:generate` → apply migration. Types are inferred via `InferSelectModel`, not hand-maintained. Use `.$type<T>()` on text columns to narrow to union types (e.g., `PlanId`, deployment status).
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `dispatch`. Not applied to `api` (its tests use Miniflare/Node which needs DOM-compatible `URL` types).
- **OAuth env vars use `_CLIENT_` prefix** (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). These are passed explicitly to `@hono/oauth-providers` middleware, overriding its default `GITHUB_ID`/`GOOGLE_ID` convention, to avoid naming collisions and make the purpose clear.
- **D1 does not allow `PRAGMA foreign_keys=OFF`** — D1 enforces `foreign_keys=ON` always. Drizzle-generated migrations that do table rebuilds (e.g. adding NOT NULL to an existing column) use `PRAGMA foreign_keys=OFF/ON`, which silently fails on D1. Hand-edit these to `PRAGMA defer_foreign_keys=on/off` instead, which defers FK checks to the end of the current transaction.
- **Deploy protocol versioning** — The `DeployManifest` interface has a `version` field. The API validates it and rejects unknown versions with a clear error. See `meta/design-docs/0018-open-source-split.md` for the versioning policy.
