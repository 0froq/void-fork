This is the development repo of Vite Cloud.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- This file describes the current state of the codebase. To understand Vite Cloud as a product, read the [Introduction](./docs/index.md).
- Refer to the [Design Doc](./meta/design-docs/0001-design.md) for the high-level vision and architecture.
- Refer to the [Progress Doc](./meta/progress.md) for tracking progress.
- Documentation source lives in `packages/website/docs/`. A root-level `docs/` symlink points there for convenience.

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
    - relevant docs md files in `packages/website/docs`
    - `packages/vite-cloud/skills/vite-cloud` (if change affects skill/CLI guidance)
    - `packages/vite-cloud/AGENT_PROMPT.md`
    - `packages/vite-cloud/getting-started-prompt.txt`
  - Progress tracking: tick off relevant steps in `meta/progress.md` when applicable.

## Quick Reference

```
pnpm -r build                       # Build all packages
pnpn -C packages/vite-cloud build   # Build only the core plugin
pnpm test                           # Run vitest (unit + integration tests)
pnpm test packages/vite-cloud.      # Only test the core plugin
pnpm lint                           # oxlint
pnpm fmt                            # oxfmt --write .
pnpm check                          # Typecheck all packages (tsc --noEmit)
pnpm -C packages/vue typecheck.     # Typecheck a specific package
pnpm run deploy                     # Build all + deploy platform & dispatch workers (production)
pnpm run deploy:staging             # Deploy all workers to staging environment
```

**Manual deploys only. Do not ask to push or deploy.**

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (typescript, tsdown, vite, @cloudflare/workers-types, wrangler). Make sure to run `pnpm install` after making package structure changes.

| Package                                                  | npm name                         | Purpose                                                   |
| -------------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| [`packages/vite-cloud`](./packages/vite-cloud/AGENTS.md) | `vite-cloud`                     | Core Vite plugin — routing, inference, migrations, CLI    |
| [`packages/vue`](./packages/vue/README.md)               | `@vite-cloud/vue`                | Vue framework adapter for Pages mode (SSR, Link, useForm) |
| [`packages/platform`](./packages/platform/README.md)     | `@vite-cloud/platform` (private) | Control Plane API + Admin Dashboard                       |
| [`packages/dispatch`](./packages/dispatch/README.md)     | `@vite-cloud/dispatch` (private) | Routes `*.vitecloud.app` to user workers + R2 assets      |
| `playground/*`                                           | (private)                        | local apps for testing                                    |

## `vite-cloud` Overview

The `vite-cloud` package contains two parts:

**Vite plugin** — `viteCloud()` returns `[routingPlugin, migrationPlugin, cloudflare({...inferredBindings})]`. Depends on `@cloudflare/vite-plugin` and transitively on wrangler/miniflare.

- **Routing** — file-based API routing on Hono with named HTTP method exports
- **Validation** — request body/query/params validation via any Standard Schema library
- **Typed fetch client** — fully-inferred client from route definitions
- **Typed DB** — auto-generated types from SQL migrations
- **Auth** — built-in email/password + OAuth, auto-detected from imports and env vars
- **Cron jobs** — scheduled handlers via `defineScheduled`
- **Queues** — typed producers and consumers via `defineQueue`
- **Binding inference** — auto-detects D1, KV, R2, queues from source code
- **Migration runner** — applies SQL migrations to local D1 on dev startup

**CLI (`vcc`)** — commands for local development DX and deployment:

- **`deploy`** — builds, validates migrations, packages, and uploads to Vite Cloud
- **`gen`** — scaffolds models, routes, middleware, SSR entries, cron jobs, and queue consumers
- **`init`** — sets up agent instructions, skills, and reference prompts for coding agents
- **`db`** — manages migrations and inspects the local D1 database
- **`auth`** — login, logout, and token management
- **`projects`** — link, create, and manage Vite Cloud projects
- **`domains`** — configure custom domains for deployed projects
- **`secrets`** — manage production environment variables

See [`packages/vite-cloud/AGENTS.md`](./packages/vite-cloud/AGENTS.md) for architecture, source layout, design decisions, package exports, route parsing rules, code generation, and agent integration.

**Note:** `packages/vite-cloud/skills/vite-cloud/docs` is ignored from git and is auto copied during build. Ignore files in this directory.

## `@vite-cloud/vue` Overview

Vue framework adapter for Pages mode — Inertia-inspired full-stack DX with SSR.

- **Plugin** (`@vite-cloud/vue/plugin`): `viteCloudVue()` — extracts `<script server>` blocks, compiles Vue SFCs, generates SSR + client hydration entries
- **Runtime** (`@vite-cloud/vue`): `Link`, `useForm`, `useShared` composables
- **Server handlers**: Remix-style `loader` (GET → props) and `action` (mutations) exports in `<script server>` or companion `.server.ts` files

See [`packages/vue/README.md`](./packages/vue/README.md) for architecture and [`meta/design-docs/0013-pages.md`](./meta/design-docs/0013-pages.md) for the design doc.

## `platform` Overview

CF Worker serving the Control Plane API + Admin Dashboard. Handles OAuth (GitHub/Google), project CRUD, deploy pipeline (migrations → assets → worker upload), usage metering via Analytics Engine, and plan tier enforcement. Admin dashboard uses Hono JSX with cookie-based auth. Uses Drizzle ORM with D1 for type-safe database queries — schema defined in `src/schema.ts`, types inferred via `InferSelectModel`.

See [`packages/platform/README.md`](./packages/platform/README.md) for API endpoints, auth flow, deploy flow, tiers, secrets, and CF API token permissions.

## `dispatch` Overview

CF Worker routing `*.vitecloud.app` traffic. Extracts slug from hostname → KV lookup → serves API routes via Workers for Platforms (with custom CPU/subrequest limits) or static assets from R2 (with edge caching). Records every request to Analytics Engine for usage metering. Also relays Cloudflare Queue batches to user workers via KV-based routing.

See [`packages/dispatch/README.md`](./packages/dispatch/README.md) for request flow, metering schema, and edge caching strategy.

## Tooling

| Tool     | Version       | Purpose                                                                                        |
| -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Node.js  | 24.13.1       | Runtime (TS type stripping enabled natively — no `tsx` or `--experimental-strip-types` needed) |
| pnpm     | 10.x          | Package manager with workspaces + catalog                                                      |
| tsdown   | 0.20.3        | Build (rolldown-based, ESM, DTS)                                                               |
| wrangler | 4.x           | CF Worker dev/deploy (platform, dispatch)                                                      |
| drizzle  | 0.45.x        | Type-safe ORM for platform D1 (schema + queries + migrations)                                  |
| vitest   | 4.x           | Unit + integration tests                                                                       |
| oxlint   | 1.47.x        | Linting                                                                                        |
| oxfmt    | 0.32.x        | Formatting (double quotes, semis)                                                              |
| vite     | 8.0.0-beta.14 | Dev server + build                                                                             |

## Testing

Tests run from root with `pnpm test` (vitest). 955 tests across 75 files. See each package README for detailed test listings.

## Playground

Local apps for testing features end-to-end. Run scripts with `pnpm -C playground/<app> <script>` (e.g. `pnpm -C playground/spa dev`).

| App                                                       | Description                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`spa`](./playground/spa/README.md)                       | React SPA — API routes, valibot validation, typed DB, typed fetch client, middleware, cron jobs   |
| [`ssr`](./playground/ssr/README.md)                       | React SSR — `defineRender()`, client hydration, KV storage, dynamic markdown blog                 |
| [`vue-pages`](./playground/vue-pages/README.md)           | Vue Pages mode — `<script server>` blocks, Inertia protocol, SSR, layouts, `useForm`, `useShared` |
| [`queues`](./playground/queues/README.md)                 | API-only — typed queue producer/consumer with KV bridge                                           |
| [`auth`](./playground/auth/README.md)                     | React SPA — email/password + OAuth (GitHub/Google) auth flows, protected routes                   |
| [`tanstack-start`](./playground/tanstack-start/README.md) | TanStack Start meta-framework — server functions, D1 queries, SSR via TanStack                    |

## Operations

Two environments: **production** (`*.vitecloud.app`, manual deploy via `prod` branch) and **staging** (`*.staging.vitecloud.app`, auto-deploys on push to `main`). Each has fully isolated CF resources (D1, KV, R2, dispatch namespace, analytics engine).

```
pnpm run deploy           # Production
pnpm run deploy:staging   # Staging
```

See [`meta/operations.md`](./meta/operations.md) for the full operations reference — CF resources, secrets, environment variables, DNS setup, GitHub Actions, and fresh environment provisioning.

## Pitfalls / Things That Broke

- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
- **Miniflare D1 `exec()` with multi-statement SQL** fails with `Cannot read properties of undefined (reading 'duration')`. Split into individual statements and use `db.batch(stmts.map(s => db.prepare(s)))` instead.
- **Platform DB uses Drizzle ORM** — schema is the source of truth in `src/schema.ts`. To add columns or tables: update schema → `pnpm db:generate` → apply migration. Types are inferred via `InferSelectModel`, not hand-maintained. Use `.$type<T>()` on text columns to narrow to union types (e.g., `PlanId`, deployment status).
- **ArkType `ArkErrors.map()` returns `ArkErrors`** (not a plain array), causing `Response.json()` serialization to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead of `issues.map(mapper)` when flattening Standard Schema issues.
- **tsconfig `extends` does NOT merge `include`/`files`** — the child completely replaces the parent's. To make generated types discoverable, the `.vite-cloud/tsconfig.json` uses `"files"` (inherited when the child doesn't specify `files`) rather than `"include"` (overridden by the child's `include`).
- **`declare module` augmentation requires `export {}`** at the top of the generated file. Without a top-level export/import, TypeScript treats it as an ambient module declaration (replaces the module entirely) rather than an augmentation (merges with existing exports). This hides runtime exports like `db` and `createDb`. Both `routes.d.ts` and `db.d.ts` use `export {}` to ensure augmentation semantics.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `dispatch` and `vite-cloud`. Not applied to `platform` (its tests use Miniflare/Node which needs DOM-compatible `URL` types).
- **OAuth env vars use `_OAUTH_` prefix** (`GITHUB_OAUTH_ID`, `GITHUB_OAUTH_SECRET`, `GOOGLE_OAUTH_ID`, `GOOGLE_OAUTH_SECRET`). These are passed explicitly to `@hono/oauth-providers` middleware, overriding its default `GITHUB_ID`/`GOOGLE_ID` convention, to avoid naming collisions and make the purpose clear.
- **D1 does not allow `PRAGMA foreign_keys=OFF`** — D1 enforces `foreign_keys=ON` always. Drizzle-generated migrations that do table rebuilds (e.g. adding NOT NULL to an existing column) use `PRAGMA foreign_keys=OFF/ON`, which silently fails on D1. Hand-edit these to `PRAGMA defer_foreign_keys=on/off` instead, which defers FK checks to the end of the current transaction.
- **Vite config plugins option accepts array of plugins by default** - there is no need to spread plugins that export an array of plugins.
