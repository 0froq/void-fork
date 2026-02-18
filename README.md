This is the development repo of Vite Cloud.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- This file describes the current state of the codebase. To understand Vite Cloud as a product, read the [Introduction](./docs/index.md).
- Refer to the [Design Doc](./meta/0001-design.md) for the high-level vision and architecture.
- Refer to the [Progress Doc](./meta/0000-progress.md) for tracking progress.
- Documentation source lives in `packages/website/docs/`. A root-level `docs/` symlink points there for convenience.

## Plan Mode Best Practices

Every implementation plan should include the following:

- Verification: run `pnpm lint`, `pnpm fmt`, and `pnpm check`. Run `pnpm test` on tests relevant to the current feature first, then run the full test suite.
- Documentation: after verification, update `README.md` (this file) with relevant changes, and also update relevant docs md files in `packages/website/docs`.
- Progress tracking: tick off relevant steps in `meta/0000-progress.md` when applicable.
- Design decision log (optional): for particularly substantial changes, ask the user if they want to create a numbered design decision doc in `meta` following existing file format.

## Quick Reference

```
pnpm -r build        # Build all packages
pnpm test            # Run vitest (unit + integration tests)
pnpm lint            # oxlint
pnpm fmt             # oxfmt --write .
pnpm check           # Typecheck all packages (tsc --noEmit)
pnpm run deploy      # Build all + deploy platform, dispatch & admin workers (production)
pnpm run deploy:staging  # Deploy all workers to staging environment
```

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (typescript, tsdown, vite, @cloudflare/workers-types, wrangler).

| Package                      | npm name                         | Purpose                                                |
| ---------------------------- | -------------------------------- | ------------------------------------------------------ |
| `packages/vite-cloud`        | `vite-cloud`                     | Core Vite plugin — routing, inference, migrations, CLI |
| `packages/platform`          | `@vite-cloud/platform` (private) | Control Plane API — projects, deploys, CF API proxy    |
| `packages/dispatch`          | `@vite-cloud/dispatch` (private) | Routes `*.vitecloud.app` to user workers + R2 assets   |
| `packages/admin`             | `@vite-cloud/admin` (private)    | Admin dashboard (Hono JSX, server-rendered)            |
| `packages/create-vite-cloud` | `create-vite-cloud`              | `npm create vite-cloud` scaffolding CLI                |
| `playground/*`               | (private)                        | local apps for testing                                 |

## `vite-cloud` Architecture

The main export `viteCloud()` returns an array of Vite plugins + the `cloudflare()` plugin:

```
viteCloud() → [routingPlugin, migrationPlugin, cloudflare({...inferredBindings})]
```

### Runtime Framework

**Hono** is used as the runtime framework. The generated virtual module creates a Hono app with file-based routes and middleware. Route handlers receive a Hono `Context` object (`c`) and can use the full Hono API (`c.json()`, `c.text()`, `c.req.param()`, etc.) plus the Hono middleware ecosystem.

- `defineHandler(fn)` — wraps a route handler `(c: CloudContext) => R`, returns `TypedHandler<{}, R>`
- `defineHandler.withValidator(validators)(fn)` — validates body/query/params via Standard Schema before calling handler, returns `TypedHandler<V, R>` with phantom types for codegen
- `defineMiddleware(fn)` — wraps Hono middleware `(c, next) => void`
- Handlers can return plain objects/strings (auto-converted via `convertReturnValue`) or use Hono's `c.json()` / `c.text()` directly.
- Route files use **named HTTP method exports** (`export const GET`, `export const POST`, etc.) — one file per path, multiple methods per file.

### Source Layout

```
src/
  index.ts                  # Main export: viteCloud() → Plugin[]
  config.ts                 # readConfig(), ViteCloudConfig, convertHeadersConfig(), normalizeAuth()
  plugin-routing.ts         # Virtual module resolution, file watching, HMR, type codegen
  plugin-inference.ts       # Binding inference orchestration (calls walk.ts)
  plugin-migration.ts       # Local migration runner on dev startup
  standard-schema.ts        # Inlined Standard Schema V1 types (no @standard-schema/spec dep)
  routes-stub.ts            # Empty RouteMap interface (augmented by generated routes.d.ts)
  router/
    parse-filename.ts       # Route filename → RouteDefinition (pure function)
    detect-exports.ts       # Detects named HTTP method exports (GET, POST, etc.) via parseSync
    scan.ts                 # Filesystem scanner using tinyglobby + export detection
    compile.ts              # Generates Hono app code + worker entry
  codegen/
    route-types.ts          # Generates .vite-cloud/routes.d.ts (RouteMap with Serialize + ExtractInput)
    db-types.ts             # Generates .vite-cloud/db.d.ts (DbTables + DbInsertTables from migrations)
  runtime/
    handler.ts              # defineHandler(), defineHandler.withValidator(), defineMiddleware()
    validator.ts            # runValidation() — Standard Schema body/query/params validation
    response.ts             # convertReturnValue() — return → Response
    fetch.ts                # Typed fetch client for vite-cloud/client
    db.ts                   # Typed query client (db.list/get/insert/update/delete/raw) + DbTables/DbInsertTables stubs
  inference/
    walk.ts                 # AST walking with vite's parseSync + estree-walker
  migrations/
    runner.ts               # Applies .sql files to local SQLite via better-sqlite3
    collect.ts              # Reads .sql files from migrations/ dir, sorted by filename
    validate.ts             # Destructive-op detection + pragma enforcement
    schema.ts               # SQL DDL parser → SchemaMap (replays CREATE/ALTER/DROP TABLE)
  cli/
    cli.ts                  # CLI entry: `vite-cloud deploy|link|login`
    deploy.ts               # Orchestrator: build → collect/validate migrations → package → upload
    project.ts              # Reads/creates .vite-cloud/project.json (projectId + slug only)
    auth.ts                 # Token read/save + runLogin() (local server + browser OAuth)
    login.ts                # Login command UI (@clack/prompts)
    package.ts              # Packages dist/ into FormData (worker + assets + migrations + manifest)
    client.ts               # HTTP client for platform API
    types.ts                # DeployManifest, MigrationMeta types
```

### Key Design Decisions

- **Import redirection**: The routing plugin's `resolveId` hook redirects bare `"vite-cloud"` imports to `vite-cloud/handler` (the lightweight subpath). Without this, route files pull the entire plugin (vite, @cloudflare/vite-plugin, lightningcss) into the Worker bundle. Uses `import.meta.resolve()` to compute absolute paths at plugin init.
- **Pre-resolved paths in codegen**: Generated virtual module code uses absolute paths for `hono` and `vite-cloud/response` (resolved via `import.meta.resolve()`). Virtual modules have no filesystem location, so bare specifiers can't resolve from them.
- **CF plugin API**: Worker config (`main`, `d1_databases`, `kv_namespaces`, `r2_buckets`) goes inside the `config` option of `cloudflare()`, NOT as top-level properties. `persistState` takes `{ path: string }`, not a raw string. The `config` option uses a **function form** `(resolved: WorkerConfig) => Partial<WorkerConfig>` so that bindings from the user's `wrangler.json` (if present) take precedence over inferred placeholder bindings.
- **Migration DB path**: Miniflare stores D1 data at a deterministic path computed from the `database_id` using HMAC-SHA256. The `getMiniflareDatabasePath()` function in `migrations/runner.ts` replicates this algorithm so migrations target the correct SQLite file at `.vite-cloud/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`.

### Package Exports

| Subpath                | What                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `vite-cloud`           | `viteCloud()` default export + `defineHandler` + `defineMiddleware` + `CloudContext` type               |
| `vite-cloud/handler`   | `defineHandler()`, `defineHandler.withValidator()`, `defineMiddleware()`, types                         |
| `vite-cloud/response`  | `convertReturnValue()`                                                                                  |
| `vite-cloud/validator` | `runValidation()`, `ValidatorSlots`, `HandlerInput` types                                               |
| `vite-cloud/routes`    | Empty `RouteMap` stub interface (augmented by generated `routes.d.ts`)                                  |
| `vite-cloud/client`    | Typed `fetch()` client + `FetchError`                                                                   |
| `vite-cloud/db`        | `db` query client + `createDb()` + `DbTables`/`DbInsertTables` stubs (augmented by generated `db.d.ts`) |
| `vite-cloud/env`       | Global Cloudflare env types (`D1Database`, `KVNamespace`, `R2Bucket`)                                   |

The CLI binary is at `dist/cli/cli.mjs` (declared in `bin` field of package.json).

Build output uses `.mjs` / `.d.mts` extensions (tsdown 0.20.3 default).

### Route Filename Parsing Rules

Applied in order to a path relative to `routes/`:

1. Strip extension (`.ts`, `.js`, `.mts`, `.mjs`)
2. Strip env suffix (`.dev`, `.prod`)
3. Strip trailing `index`
4. Remove route group dirs `(groupname)`
5. Convert `[param]` → `:param`, `[...param]` → `**:param`, `[...]` → `**`
6. Prefix with `/`

HTTP methods are determined by **named exports** in each file (detected by `detect-exports.ts` via `parseSync`), not by filename suffixes. Files/dirs starting with `_` are ignored by the scanner.

## `platform` Architecture

CF Worker serving the Control Plane API. Uses Hono, D1, R2, KV, and Workers for Platforms (dispatch namespaces). No tsdown — wrangler handles TS bundling.

### Source Layout

```
src/
  index.ts                  # Hono app + scheduled handler (cron), mounts route groups + auth middleware
  env.ts                    # PlatformEnv type (D1, R2, KV, DISPATCH, secrets, Variables)
  types.ts                  # User, Project, Deployment, Resource, DeployManifest
  id.ts                     # generateId(prefix) → "proj_a1b2c3d4e5f6"
  db.ts                     # Typed D1 query wrappers (CRUD for all tables)
  tiers.ts                  # PlanId, PlanLimits, PLAN_LIMITS constants, getPlanLimits(), isWithinLimit()
  auth/
    jwt.ts                  # HS256 JWT sign/verify via Web Crypto API
    github.ts               # GitHub OAuth helpers (authorize URL, code→token, user profile)
    google.ts               # Google OAuth helpers (authorize URL, code→token, user profile)
  middleware/
    auth.ts                 # Bearer token verification, sets userId/userLogin on context
  migrations/
    remote-runner.ts        # Executes migrations on remote D1 via CF REST API
    validate.ts             # Server-side destructive-op validation (defense in depth)
  routes/
    auth.ts                 # GET /auth/login + GET /auth/callback (GitHub/Google OAuth flow)
    projects.ts             # POST /projects, GET /projects/:id
    deploy.ts               # POST /projects/:id/deploy (migrations → assets → worker)
    usage.ts                # GET /projects/:id/usage, GET /usage (Analytics Engine queries)
migrations/
  0001_initial.sql          # users, projects, deployments, resources tables
  0002_provider_auth.sql    # Migrate users to provider-agnostic schema
  ...
  0006_usage_tiers.sql      # Add plan column to users table
```

### Auth Flow

`GET /auth/login?redirect=http://localhost:{port}/callback&provider=github|google` → HMAC-signed state (includes `provider`) → GitHub or Google OAuth → `GET /auth/callback` → extract `provider` from state → exchange code → upsert user (with duplicate email check across providers) → sign JWT → redirect to CLI with `?token=`.

The CLI's `vcd login` prompts user to choose GitHub or Google, then passes `provider` in the query string. On email conflict (same email registered under different provider), the callback redirects with `?error=email_conflict&existing_provider=...`.

The `User` type uses provider-agnostic columns: `provider` (`"github"` | `"google"`), `provider_id` (TEXT — GitHub numeric ID cast to string, Google opaque sub), `login` (GitHub username or Google email), `plan` (defaults to `"free"`).

Auth middleware on `/projects/*` extracts Bearer token, verifies JWT, sets `c.get("userId")` and `c.get("userLogin")`. Deploy endpoint checks `project.user_id === c.get("userId")` for ownership.

### Deploy Endpoint Flow

`POST /projects/:id/deploy` receives multipart form data:

1. Ownership check: `project.user_id` must match authenticated user
2. **Deploy count enforcement**: Look up user plan, check `countUserDeploymentsToday()` against `planLimits.deploysPerDay` → 429 if exceeded
3. Provision bindings (D1, KV, R2) — creates CF resources if needed
4. `migration:<name>` fields → validated, then executed on D1 via CF REST API (status: `"migrating"`)
5. `asset:<path>` fields → stored in R2 at `{projectId}/current/{path}`
6. `worker:<path>` fields → uploaded to CF dispatch namespace via API
7. KV routing updated: `slug → { workerName, projectId, version, limits?, suspended? }`
   - `limits` includes `cpuMs` and `subRequests` from user's plan (omitted when all unlimited)
   - `suspended` is carried forward from the existing KV entry to avoid race conditions with cron
8. Deployment marked as `live`

**Key invariant:** Worker is never deployed unless all migrations succeed. On migration failure, deployment is marked `"failed"` and the existing worker keeps running.

### Usage Metering & Tiers

Five plan tiers: `free`, `solo`, `pro`, `sponsored`, `custom`. Defined in `src/tiers.ts` with `PLAN_LIMITS` constant. `0` = unlimited for any field. The `isWithinLimit(limit, current)` helper centralizes the unlimited-check logic.

- **Immediate enforcement**: Deploy count per day (checked at deploy time via D1 query)
- **Per-request enforcement**: CPU time and sub-requests via CF Custom Limits (passed in KV routing `limits` field, applied by dispatch worker)
- **Async enforcement**: Request count per month via Cron Trigger (`*/5 * * * *`) — queries Analytics Engine, sets/clears `suspended` flag in KV routing entries
- **Usage queries**: `GET /projects/:id/usage` (per-project) and `GET /usage` (aggregate) query Analytics Engine SQL API with `_sample_interval` multiplier

The platform default export is `{ fetch: app.fetch, scheduled }` — `app` (the Hono instance) is also exported as a named export for integration tests.

### Secrets (via `wrangler secret put`)

| Secret                 | platform | admin | dispatch | Staging notes                                        |
| ---------------------- | -------- | ----- | -------- | ---------------------------------------------------- |
| `CF_API_TOKEN`         | yes      |       |          | Can share with production                            |
| `CF_ACCOUNT_ID`        | yes      |       |          | Can share with production                            |
| `CF_ZONE_ID`           | yes      |       |          | Can share with production                            |
| `JWT_SECRET`           | yes      | yes   |          | Must differ from production; independent per worker  |
| `GITHUB_CLIENT_ID`     | yes      |       |          | Can share with production (add staging callback URL) |
| `GITHUB_CLIENT_SECRET` | yes      |       |          | Can share with production                            |
| `GOOGLE_CLIENT_ID`     | yes      | yes   |          | Can share with production (add staging callback URL) |
| `GOOGLE_CLIENT_SECRET` | yes      | yes   |          | Can share with production                            |

`AUTH_REDIRECT_URI` is set as a `vars` entry in wrangler config for staging (`https://api.staging.vite.cloud/auth/callback`). For local dev, set `AUTH_REDIRECT_URI=http://localhost:8787/auth/callback` in `.dev.vars`.

### Cloudflare API Token Permissions

Two tokens are needed: a **deploy token** (used by wrangler / CI) and a **runtime token** (used by the platform worker to provision user resources). A single token can serve both roles if it has the union of all permissions.

**Account-wide features** (enabled on the account, not configurable per-token): Workers for Platforms, Cloudflare for SaaS.

#### Deploy Token (`CLOUDFLARE_API_TOKEN`)

Used by `pnpm run deploy` and GitHub Actions to deploy all three workers.

**Account permissions:**

| Permission         | Access | Reason                                       |
| ------------------ | ------ | -------------------------------------------- |
| Workers Scripts    | Edit   | Deploy platform, dispatch, and admin workers |
| Workers KV Storage | Edit   | KV namespace bindings (ROUTING)              |
| D1                 | Edit   | D1 database bindings (DB)                    |
| Workers R2 Storage | Edit   | R2 bucket bindings (ASSETS)                  |

**Zone permissions** (on `vitecloud.app`):

| Permission     | Access | Reason                                               |
| -------------- | ------ | ---------------------------------------------------- |
| Workers Routes | Edit   | Dispatch worker route patterns (`*.vitecloud.app/*`) |
| DNS            | Read   | Zone lookup for route binding                        |

#### Runtime Token (`CF_API_TOKEN` secret)

Used by the platform worker at runtime to provision and manage user resources via the CF REST API.

**Account permissions:**

| Permission         | Access | Reason                                                 |
| ------------------ | ------ | ------------------------------------------------------ |
| Workers Scripts    | Edit   | Upload/delete user workers in dispatch namespace       |
| D1                 | Edit   | Create databases, execute migrations, delete databases |
| Workers KV Storage | Edit   | Create/delete KV namespaces                            |
| Workers R2 Storage | Edit   | Create/delete R2 buckets                               |
| Account Analytics  | Read   | Query Analytics Engine SQL API for usage metering      |

**Zone permissions** (on `vitecloud.app`):

| Permission           | Access | Reason                                      |
| -------------------- | ------ | ------------------------------------------- |
| SSL and Certificates | Edit   | Custom hostname DV certificate provisioning |

## `dispatch` Architecture

CF Worker routing `*.vitecloud.app` traffic to user workers and static assets. No framework — plain `fetch` handler.

### Request Flow

1. Extract slug from hostname (`{slug}.vitecloud.app`)
2. KV lookup: `slug → { workerName, projectId, version, limits?, suspended? }`
3. **Suspension check**: If `routing.suspended` is set → return 429 `{ error: "usage limit exceeded", reason }`
4. Edge cache check via `caches.default` with versioned cache key (`?_v={version}`)
5. `/api/*` → `getWorker(env, routing).fetch(request)` with custom limits (Workers for Platforms, not cached). CPU limit errors caught → 429
6. Everything else → serve static assets from R2 (SPA fallback to `index.html`), cache response at edge
7. **Metering**: Every request (except 404/suspended) records an Analytics Engine data point via `ctx.waitUntil` (fire-and-forget, zero latency impact)

### Source Layout

```
src/
  index.ts                  # Main fetch handler + suspension check + custom limits
  env.ts                    # Env interface (DISPATCH, ASSETS, ROUTING, ANALYTICS, BASE_HOSTNAME?)
  hostname.ts               # extractSlug() — pure function
  static.ts                 # serveStaticAsset() — R2 lookup, SPA fallback, cache headers
  metering.ts               # recordRequest() — Analytics Engine writeDataPoint wrapper
```

### Metering (Analytics Engine)

Every request is recorded via `recordRequest()` using `ctx.waitUntil` (non-blocking). Data point schema:

| Field   | Value                                 |
| ------- | ------------------------------------- |
| index   | projectId (sampling key)              |
| blob1-5 | projectId, type, method, status, slug |
| double1 | 1 (for SUM counting)                  |
| double2 | responseBytes                         |
| double3 | durationMs                            |

Request types: `"api"`, `"static"`, `"ssr"`, `"isr"`. Usage queries multiply by `_sample_interval` for accuracy at high traffic.

### Edge Caching

Static asset responses are cached at the CF edge via `caches.default`. Cache keys include a `version` from the KV routing entry (set to the deployment ID on each deploy), so new deploys instantly invalidate stale entries without purge APIs.

- Hashed assets (`assets/*-<hash>.js`) get `Cache-Control: public, max-age=31536000, immutable` — cached at edge ~1 year
- Non-hashed assets (`index.html` etc.) get `Cache-Control: public, s-maxage=60, max-age=0, must-revalidate` — cached at edge 60s, browser always revalidates
- API routes and SSR-rendered responses are **not** edge-cached
- Non-file paths fall back to `index.html` (SPA routing)

## `admin` Architecture

CF Worker serving the Admin Dashboard (Hono JSX, server-rendered). Shares the same D1 database as the platform worker.

### Auth

Cookie-based JWT auth with its own independent `JWT_SECRET` (does not need to match the platform's). Login flow handles Google OAuth directly (using shared helper functions from `@vite-cloud/platform`), then verifies `role === "admin"` from D1. Non-admins get 403.

### Source Layout

```
packages/admin/
  package.json              # hono, @vite-cloud/platform (workspace dep)
  wrangler.jsonc
  tsconfig.json
  src/
    index.ts                # Hono app default export
    env.ts                  # AdminEnv type (DB, ROUTING, JWT_SECRET)
    middleware/
      auth.ts               # JWT verify (cookie) + role === "admin" check
    routes/
      login.ts              # GET /login, /login/github, /login/google, /callback, /logout
      users.tsx             # GET /users, GET /users/:id, POST /users/:id/plan|suspend|unsuspend
      projects.tsx          # GET /projects, GET /projects/:id
      system.tsx            # GET / (dashboard home with stats)
    views/
      layout.tsx            # HTML shell (head, nav, body)
      users-list.tsx        # Users table with search/filter form
      user-detail.tsx       # User profile, projects, plan controls, suspend button
      projects-list.tsx     # All projects table
      dashboard.tsx         # System stats overview
```

### Platform Admin API

The platform exposes `/admin/*` endpoints (protected by auth + admin middleware):

```
GET    /admin/users                  # List users (paginated, searchable)
GET    /admin/users/:id              # User detail with projects
POST   /admin/users/:id/plan         # Change plan
POST   /admin/users/:id/suspend      # Suspend user
POST   /admin/users/:id/unsuspend    # Unsuspend user
GET    /admin/projects               # List all projects
GET    /admin/projects/:id           # Project detail with deployments/resources
GET    /admin/stats                  # System-wide stats
```

### Platform Subpath Exports

The platform package exposes `.ts` source files via subpath exports for consumption by the admin worker (wrangler handles TS bundling):

| Subpath                            | File                 |
| ---------------------------------- | -------------------- |
| `@vite-cloud/platform/db`          | `src/db.ts`          |
| `@vite-cloud/platform/types`       | `src/types.ts`       |
| `@vite-cloud/platform/id`          | `src/id.ts`          |
| `@vite-cloud/platform/tiers`       | `src/tiers.ts`       |
| `@vite-cloud/platform/auth/jwt`    | `src/auth/jwt.ts`    |
| `@vite-cloud/platform/auth/github` | `src/auth/github.ts` |
| `@vite-cloud/platform/auth/google` | `src/auth/google.ts` |

## Tooling

| Tool     | Version       | Purpose                                                                                        |
| -------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Node.js  | 24.13.1       | Runtime (TS type stripping enabled natively — no `tsx` or `--experimental-strip-types` needed) |
| pnpm     | 10.x          | Package manager with workspaces + catalog                                                      |
| tsdown   | 0.20.3        | Build (rolldown-based, ESM, DTS)                                                               |
| wrangler | 4.x           | CF Worker dev/deploy (platform, dispatch)                                                      |
| vitest   | 4.x           | Unit + integration tests                                                                       |
| oxlint   | 1.47.x        | Linting                                                                                        |
| oxfmt    | 0.32.x        | Formatting (double quotes, semis)                                                              |
| vite     | 8.0.0-beta.14 | Dev server + build                                                                             |

## Testing

Tests run from root with `pnpm test` (vitest). 747 tests across 63 files.

### Unit Tests

| Test file                                                      | Covers                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/vite-cloud/test/unit/parse-filename.test.ts`         | Route filename parsing (21 tests)                              |
| `packages/vite-cloud/test/unit/scan.test.ts`                   | Filesystem scanning (8 tests)                                  |
| `packages/vite-cloud/test/unit/detect-exports.test.ts`         | Named HTTP method export detection (8 tests)                   |
| `packages/vite-cloud/test/unit/compile.test.ts`                | Code generation (5 tests)                                      |
| `packages/vite-cloud/test/unit/response.test.ts`               | Return value → Response (8 tests)                              |
| `packages/vite-cloud/test/unit/inference.test.ts`              | AST-based binding inference (11 tests)                         |
| `packages/vite-cloud/test/unit/validate-migrations.test.ts`    | Destructive-op detection + pragma (12 tests)                   |
| `packages/vite-cloud/test/unit/collect-migrations.test.ts`     | Migration file collection (4 tests)                            |
| `packages/vite-cloud/test/unit/validator.test.ts`              | Standard Schema validation runtime (8 tests)                   |
| `packages/vite-cloud/test/unit/validator-real-schemas.test.ts` | Real schema validation (zod/valibot/arktype) (16 tests)        |
| `packages/vite-cloud/test/unit/define-handler.test.ts`         | defineHandler + middleware composition (18 tests)              |
| `packages/vite-cloud/test/unit/fetch.test.ts`                  | Typed fetch client (9 tests)                                   |
| `packages/vite-cloud/test/unit/route-types.test.ts`            | Route type codegen output (6 tests)                            |
| `packages/vite-cloud/test/unit/route-type-extraction.test.ts`  | Type extraction pipeline (Serialize + ExtractInput) (14 tests) |
| `packages/vite-cloud/test/unit/schema.test.ts`                 | SQL DDL parser (41 tests)                                      |
| `packages/vite-cloud/test/unit/db-types.test.ts`               | DB type codegen output (8 tests)                               |
| `packages/vite-cloud/test/unit/db.test.ts`                     | Typed query client + type-level inference (25 tests)           |
| `packages/dispatch/test/unit/hostname.test.ts`                 | Slug extraction from hostname (18 tests)                       |
| `packages/dispatch/test/unit/metering.test.ts`                 | Analytics Engine data point shape (5 tests)                    |
| `packages/platform/test/unit/provision.test.ts`                | Binding provisioning engine (7 tests)                          |
| `packages/platform/test/unit/jwt.test.ts`                      | JWT sign/verify round-trip (5 tests)                           |
| `packages/platform/test/unit/remote-runner.test.ts`            | Remote D1 migration execution (7 tests)                        |
| `packages/platform/test/unit/tiers.test.ts`                    | Plan limits, getPlanLimits(), isWithinLimit() (11 tests)       |

### Integration Tests

Platform integration tests call the Hono app via `app.fetch(request, env)` with **real** Miniflare D1/KV/R2 bindings and **mocked** external fetch calls (GitHub API, CF API). This tests the full request→middleware→route→DB→response chain.

| Test file                                                 | Covers                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/platform/test/integration/api-health.test.ts`   | Health endpoint smoke test (1 test)                                                     |
| `packages/platform/test/integration/api-me.test.ts`       | Auth middleware: missing/invalid/expired JWT, valid (4)                                 |
| `packages/platform/test/integration/api-projects.test.ts` | Projects CRUD: auth, list, create, validation, dupes (12)                               |
| `packages/platform/test/integration/api-deploy.test.ts`   | Deploy pipeline: auth, provisioning, migrations, R2, KV, limits, failure modes (33)     |
| `packages/platform/test/integration/api-admin.test.ts`    | Admin API: middleware, users CRUD, plan change, suspend/unsuspend, stats (14)           |
| `packages/admin/test/integration/dashboard.test.ts`       | Admin dashboard: auth, pages, forms, search, pagination, deployments, login/logout (21) |

Shared helpers in `packages/platform/test/integration/helpers.ts`:

- `setupEnv()` / `teardownEnv()` — Miniflare lifecycle (D1, KV, R2 bindings)
- `clearTables()` — D1 cleanup between tests (FK order)
- `createTestUser()` / `createTestProject()` — factories with JWT signing
- `mockCfApi()` — URL-based fetch mock for CF API with configurable overrides

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

Verified working:

- `cd playground/spa && pnpm dev`
- `cd playground/ssr && pnpm dev`
- `cd playground/spa && pnpm typecheck` (includes typed routes via generated `.vite-cloud/routes.d.ts`)

## Environments

Two deployment environments: **production** and **staging**. Each has fully isolated CF resources (D1, KV, R2, dispatch namespace, analytics engine).

| Environment | Platform API             | User Sites                | Admin Dashboard            |
| ----------- | ------------------------ | ------------------------- | -------------------------- |
| Production  | `api.vite.cloud`         | `*.vitecloud.app`         | `admin.vite.cloud`         |
| Staging     | `api.staging.vite.cloud` | `*.staging.vitecloud.app` | `admin.staging.vite.cloud` |

### Configurable Environment Variables

Previously hardcoded values are now configurable via `vars` in wrangler config (defaulting to production values):

| Worker   | Variable             | Default                    | Purpose                                  |
| -------- | -------------------- | -------------------------- | ---------------------------------------- |
| platform | `ADMIN_ORIGIN`       | `https://admin.vite.cloud` | Allowed OAuth redirect origin for admin  |
| platform | `DISPATCH_NAMESPACE` | `vite-cloud-users`         | CF dispatch namespace name for API calls |
| platform | `SITE_DOMAIN`        | `vitecloud.app`            | Base domain for deploy URL output        |
| dispatch | `BASE_HOSTNAME`      | `vitecloud.app`            | Base hostname for slug extraction        |

### Deploying

```
pnpm run deploy           # Production (manual)
pnpm run deploy:staging   # Staging (auto on push to main via GitHub Actions)
```

Staging auto-deploys on push to `main` via `.github/workflows/deploy-staging.yml`. Production deploys remain manual.

### One-Time Setup (Staging)

1. Create CF resources: D1 database, KV namespace, R2 bucket, dispatch namespace, analytics engine dataset (all with `-staging` suffix)
2. Replace `PLACEHOLDER_*` IDs in wrangler configs (`packages/{platform,dispatch,admin}/wrangler.jsonc` → `env.staging`)
3. Set worker secrets: `wrangler secret put <NAME> --env staging` for each worker (platform and admin each have independent `JWT_SECRET`s — they don't need to match each other; use different values from production; OAuth creds can be shared)
4. DNS: `*.staging` CNAME on `vitecloud.app` zone; `api.staging` + `admin.staging` CNAMEs on `vite.cloud` zone
5. Add staging callback URLs to GitHub/Google OAuth apps
6. Set GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

## Pitfalls / Things That Broke

- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
- **Miniflare D1 `exec()` with multi-statement SQL** fails with `Cannot read properties of undefined (reading 'duration')`. Split into individual statements and use `db.batch(stmts.map(s => db.prepare(s)))` instead.
- **ArkType `ArkErrors.map()` returns `ArkErrors`** (not a plain array), causing `Response.json()` serialization to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead of `issues.map(mapper)` when flattening Standard Schema issues.
- **tsconfig `extends` does NOT merge `include`/`files`** — the child completely replaces the parent's. To make generated types discoverable, the `.vite-cloud/tsconfig.json` uses `"files"` (inherited when the child doesn't specify `files`) rather than `"include"` (overridden by the child's `include`).
- **`declare module` augmentation requires `export {}`** at the top of the generated file. Without a top-level export/import, TypeScript treats it as an ambient module declaration (replaces the module entirely) rather than an augmentation (merges with existing exports). This hides runtime exports like `db` and `createDb`. Both `routes.d.ts` and `db.d.ts` use `export {}` to ensure augmentation semantics.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `dispatch`, `vite-cloud`, `create-vite-cloud`. Not applied to `platform` (its tests use Miniflare/Node which needs DOM-compatible `URL` types).
