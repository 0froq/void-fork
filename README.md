This is the development repo of Vite Cloud.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- This file describes the current state of the codebase. To understand Vite Cloud as a product, read the [Introduction](./docs/index.md).
- Refer to the [Design Doc](./meta/0001-design.md) for the high-level vision and architecture.
- Refer to the [Progress Doc](./meta/0000-progress.md) for tracking progress.
- Documentation source lives in `packages/website/docs/`. A root-level `docs/` symlink points there for convenience.

## Best Practices That Must Be Followed

- **Never** commit without asking for confirmation.
- Every implementation plan should include the following:
  - Verification: run `pnpm lint`, `pnpm fmt`, and `pnpm check`. Run `pnpm test` on tests relevant to the current feature first, then run the full test suite.
  - Documentation: after verification, update `README.md` (this file) with relevant changes, and also update: affected packages's `README.md` or `AGENTS.md`, and relevant docs md files in `packages/website/docs`.
  - Progress tracking: tick off relevant steps in `meta/0000-progress.md` when applicable.
  - Design decision log (optional): for particularly substantial changes, ask the user if they want to create a numbered design decision doc in `meta` following existing file format.

## Quick Reference

```
pnpm -r build        # Build all packages
pnpm test            # Run vitest (unit + integration tests)
pnpm lint            # oxlint
pnpm fmt             # oxfmt --write .
pnpm check           # Typecheck all packages (tsc --noEmit)
pnpm run deploy      # Build all + deploy platform & dispatch workers (production)
pnpm run deploy:staging  # Deploy all workers to staging environment
```

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (typescript, tsdown, vite, @cloudflare/workers-types, wrangler).

| Package                                                  | npm name                         | Purpose                                                   |
| -------------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| [`packages/vite-cloud`](./packages/vite-cloud/AGENTS.md) | `vite-cloud`                     | Core Vite plugin — routing, inference, migrations, CLI    |
| [`packages/vue`](./packages/vue/README.md)               | `@vite-cloud/vue`                | Vue framework adapter for Pages mode (SSR, Link, useForm) |
| [`packages/platform`](./packages/platform/README.md)     | `@vite-cloud/platform` (private) | Control Plane API + Admin Dashboard                       |
| [`packages/dispatch`](./packages/dispatch/README.md)     | `@vite-cloud/dispatch` (private) | Routes `*.vitecloud.app` to user workers + R2 assets      |
| `packages/create-vite-cloud`                             | `create-vite-cloud`              | `npm create vite-cloud` scaffolding CLI                   |
| `playground/*`                                           | (private)                        | local apps for testing                                    |

## `vite-cloud` Overview

Core Vite plugin. `viteCloud()` returns `[routingPlugin, migrationPlugin, cloudflare({...inferredBindings})]`. Provides file-based routing on Hono, Standard Schema validation, typed fetch client, typed DB queries, built-in auth (auto-detected from imports + env vars), cron jobs, queues (typed via `vite-cloud/queues`), and a deploy CLI (`vcc`).

See [`packages/vite-cloud/AGENTS.md`](./packages/vite-cloud/AGENTS.md) for architecture, source layout, design decisions, package exports, and route parsing rules.

## `@vite-cloud/vue` Overview

Vue framework adapter for Pages mode — Inertia-inspired full-stack DX with SSR.

- **Plugin** (`@vite-cloud/vue/plugin`): `viteCloudVue()` — extracts `<script server>` blocks, compiles Vue SFCs, generates SSR + client hydration entries
- **Runtime** (`@vite-cloud/vue`): `Link`, `useForm`, `useShared` composables
- **Server handlers**: Remix-style `loader` (GET → props) and `action` (mutations) exports in `<script server>` or companion `.server.ts` files

See [`packages/vue/README.md`](./packages/vue/README.md) for architecture and [`meta/0013-pages.md`](./meta/0013-pages.md) for the design doc.

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

`playground/spa` is a React SPA with API routes demonstrating:

- Named method exports: `routes/api/hello.ts` (GET), `routes/api/users/index.ts` (GET + POST), `routes/api/users/[id].ts` (GET)
- Input validation: POST users uses `defineHandler.withValidator()` with valibot schemas
- Typed fetch client: `src/App.tsx` uses `fetch` from `vite-cloud/client` with full type inference
- Typed DB queries: Route handlers use `db.list("users")`, `db.get("users")`, `db.insert("users")` from `vite-cloud/db` — fully typed via generated `db.d.ts`
- Middleware: `middleware/01.logger.ts` (uses `defineMiddleware`)
- Migration: `migrations/001_create_users.sql` (creates users table + seeds data)
- Seamless tsconfig: `tsconfig.json` extends `.vite-cloud/tsconfig.json` for auto type discovery

`playground/ssr` is a minimal React SSR app demonstrating `src/main.ssr.ts` render fallback plus API routes.

`playground/queues` is a minimal API-only app demonstrating typed queues: a `queues/test-queue.ts` consumer writes to KV, `routes/api/send.ts` produces messages via `queues["test-queue"].send()`, and `routes/api/result.ts` reads the result back. Integration-tested end-to-end (send → consumer → KV round-trip).

`playground/vue-pages` is a Vue full-stack app demonstrating Inertia-inspired Pages mode:

- File-based page routing from `pages/` directory (`.vue` components with `<script server>` blocks)
- SSR with client-side hydration via `@vite-cloud/vue`
- Inertia protocol: initial load returns SSR HTML, subsequent navigations return JSON page objects via `X-Inertia` header
- `<script server>` blocks for co-located server handlers (`loader` returns props, `action` handles mutations)
- Layout nesting via `layout.vue` files
- `useForm` composable with isDirty, wasSuccessful, recentlySuccessful, validation error display
- `useShared` for middleware-set shared data (e.g. auth, app config)
- `Link` component for SPA navigation (renders `<a>` for GET, `<button>` for non-GET)
- `ValidationError` class for form validation with automatic error display
- API route coexistence (`routes/api/` alongside `pages/`)
- Integration-tested end-to-end (SSR, Inertia JSON, form submission, validation errors, shared data)

Verified working:

- `cd playground/spa && pnpm dev`
- `cd playground/ssr && pnpm dev`
- `cd playground/vue-pages && pnpm dev`
- `cd playground/spa && pnpm typecheck` (includes typed routes via generated `.vite-cloud/routes.d.ts`)

## Coding Agent Integration

Vite Cloud ships with first-class support for coding agents (Claude Code, Cursor, Codex, etc.):

- **`AGENT_PROMPT.md`** — compressed reference prompt shipped in the `vite-cloud` npm package. Covers project structure, routing, DB, auth, typed fetch, KV/storage/queues/cron, CLI, and deployment.
- **`docs/`** — all 23 docs markdown files are included in the npm package at `node_modules/vite-cloud/docs/`.
- **`vcc init --agent`** — detects existing agent files (`.claude/`, `CLAUDE.md`, `AGENTS.md`) and injects Vite Cloud instructions with versioned markers. Supports update-in-place when the version changes.
- **`vcc agent-prompt`** — prints the agent reference prompt to stdout.
- **`create-vite-cloud`** — auto-detects running agents (via `CLAUDE`, `CURSOR_SESSION_ID`, `CODEX` env vars) and creates the appropriate agent file. Interactive mode prompts users to choose.

Agent instructions use versioned markers (`<!--injected-by-vite-cloud-v0.0.1-->` / `<!--/injected-by-vite-cloud-->`) for safe update-in-place across version upgrades.

## Code Generation (`vcc gen`)

Rails/Laravel-style scaffolding commands for common boilerplate:

| Command                                           | Creates                                          |
| ------------------------------------------------- | ------------------------------------------------ |
| `vcc gen model <name> [cols...]`                  | Migration + CRUD routes + regenerates `db.d.ts`  |
| `vcc gen migration <name>`                        | Empty migration file with auto-numbered prefix   |
| `vcc gen route <path> [--methods get,post,...]`   | Route file with `defineHandler` exports          |
| `vcc gen middleware <name>`                       | Numbered middleware file with `defineMiddleware` |
| `vcc gen ssr [--react\|--vue\|--svelte\|--solid]` | SSR entry + client entry + App component         |
| `vcc gen cron <name>`                             | Cron job file with `defineScheduled` in `crons/` |
| `vcc gen queue <name>`                            | Queue consumer file with `defineQueue`           |

Column types for `gen model`: `string`, `text`, `datetime` → TEXT; `integer`, `boolean` → INTEGER; `real` → REAL; `blob` → BLOB. Append `?` for nullable (e.g. `bio:text?`).

`gen model` auto-detects your validation library (valibot, zod, or arktype) from `package.json`. If none is found, prompts to choose one or skip validation.

Source: `src/cli/gen-args.ts` (arg parsing), `src/cli/gen.ts` (command runner). Tests: `test/unit/gen-args.test.ts`, `test/unit/gen.test.ts`.

## Environments

Two deployment environments: **production** and **staging**. Each has fully isolated CF resources (D1, KV, R2, dispatch namespace, analytics engine).

| Environment | Platform (API + Admin)        | User Sites                |
| ----------- | ----------------------------- | ------------------------- |
| Production  | `platform.vite.cloud`         | `*.vitecloud.app`         |
| Staging     | `platform.staging.vite.cloud` | `*.staging.vitecloud.app` |

`api.vite.cloud` is kept as a CNAME alias for backwards compatibility with older CLI versions.

To use the CLI against staging, set `"api"` in `~/.vite-cloud/config.json` or the `VITE_CLOUD_API_URL` env var. These are internal-only — not documented in public-facing docs (`docs/cli.md`).

### Configurable Environment Variables

Previously hardcoded values are now configurable via `vars` in wrangler config (defaulting to production values):

| Worker   | Variable             | Default            | Purpose                                               |
| -------- | -------------------- | ------------------ | ----------------------------------------------------- |
| platform | `DISPATCH_NAMESPACE` | `vite-cloud-users` | CF dispatch namespace name for API calls              |
| platform | `SITE_DOMAIN`        | `vitecloud.app`    | Base domain for deploy URL output                     |
| platform | `SIGNUP_ALLOWLIST`   | (unset)            | Comma-separated emails/domains for new Google signups |
| platform | `DEV_AUTH_BYPASS`    | (unset)            | Skip admin OAuth for local dev                        |
| dispatch | `BASE_HOSTNAME`      | `vitecloud.app`    | Base hostname for slug extraction                     |

### Deploying

```
pnpm run deploy           # Production (manual)
pnpm run deploy:staging   # Staging (auto on push to main via GitHub Actions)
```

Staging auto-deploys on push to `main` via `.github/workflows/deploy-staging.yml`. Production deploys remain manual.

### One-Time Setup (Staging)

1. Create CF resources: D1 database, KV namespace, R2 bucket, dispatch namespace, analytics engine dataset (all with `-staging` suffix)
2. Replace `PLACEHOLDER_*` IDs in wrangler configs (`packages/{platform,dispatch}/wrangler.jsonc` → `env.staging`)
3. Set worker secrets: `wrangler secret put <NAME> --env staging` for the platform worker (use different values from production; OAuth creds can be shared)
4. DNS: `*.staging` CNAME on `vitecloud.app` zone; `platform.staging` CNAME on `vite.cloud` zone
5. Add staging callback URLs to GitHub/Google OAuth apps (`https://platform.staging.vite.cloud/auth/callback`, `https://platform.staging.vite.cloud/admin/callback`)
6. Set GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

## Pitfalls / Things That Broke

- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
- **Miniflare D1 `exec()` with multi-statement SQL** fails with `Cannot read properties of undefined (reading 'duration')`. Split into individual statements and use `db.batch(stmts.map(s => db.prepare(s)))` instead.
- **Platform DB uses Drizzle ORM** — schema is the source of truth in `src/schema.ts`. To add columns or tables: update schema → `pnpm db:generate` → apply migration. Types are inferred via `InferSelectModel`, not hand-maintained. Use `.$type<T>()` on text columns to narrow to union types (e.g., `PlanId`, deployment status).
- **ArkType `ArkErrors.map()` returns `ArkErrors`** (not a plain array), causing `Response.json()` serialization to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead of `issues.map(mapper)` when flattening Standard Schema issues.
- **tsconfig `extends` does NOT merge `include`/`files`** — the child completely replaces the parent's. To make generated types discoverable, the `.vite-cloud/tsconfig.json` uses `"files"` (inherited when the child doesn't specify `files`) rather than `"include"` (overridden by the child's `include`).
- **`declare module` augmentation requires `export {}`** at the top of the generated file. Without a top-level export/import, TypeScript treats it as an ambient module declaration (replaces the module entirely) rather than an augmentation (merges with existing exports). This hides runtime exports like `db` and `createDb`. Both `routes.d.ts` and `db.d.ts` use `export {}` to ensure augmentation semantics.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `dispatch`, `vite-cloud`, `create-vite-cloud`. Not applied to `platform` (its tests use Miniflare/Node which needs DOM-compatible `URL` types).
- **OAuth env vars use `_OAUTH_` prefix** (`GITHUB_OAUTH_ID`, `GITHUB_OAUTH_SECRET`, `GOOGLE_OAUTH_ID`, `GOOGLE_OAUTH_SECRET`). These are passed explicitly to `@hono/oauth-providers` middleware, overriding its default `GITHUB_ID`/`GOOGLE_ID` convention, to avoid naming collisions and make the purpose clear.
- **D1 does not allow `PRAGMA foreign_keys=OFF`** — D1 enforces `foreign_keys=ON` always. Drizzle-generated migrations that do table rebuilds (e.g. adding NOT NULL to an existing column) use `PRAGMA foreign_keys=OFF/ON`, which silently fails on D1. Hand-edit these to `PRAGMA defer_foreign_keys=on/off` instead, which defers FK checks to the end of the current transaction.
- **`packages/mcp/src/docs.ts` is auto generated and ignored by git**. Do not read or edit this file.
