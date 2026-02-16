This is the development repo of Vite Cloud.

- This file describes the current state of the codebase. To understand Vite Cloud as a product, read the [Introduction](./packages/website/docs/index.md).
- Refer to the [Design Doc](./meta/design.md) for the high-level vision and architecture.
- Refer to the [Progress Doc](./meta/progress.md) for tracking progress.

## Quick Reference

```
pnpm -r build        # Build all packages
pnpm test            # Run vitest (unit + integration tests)
pnpm lint            # oxlint
pnpm fmt             # oxfmt --write .
pnpm check           # Typecheck all packages (tsc --noEmit)
pnpm run deploy      # Build all + deploy platform & dispatch workers
```

Make sure to run `lint`, `fmt`, and `check` after major changes. Tick off relevant steps in `meta/progress.md` when applicable.

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (typescript, tsdown, vite, @cloudflare/workers-types, wrangler).

| Package                      | npm name                         | Purpose                                                |
| ---------------------------- | -------------------------------- | ------------------------------------------------------ |
| `packages/vite-cloud`        | `vite-cloud`                     | Core Vite plugin — routing, inference, migrations, CLI |
| `packages/platform`          | `@vite-cloud/platform` (private) | Control Plane API — projects, deploys, CF API proxy    |
| `packages/dispatch`          | `@vite-cloud/dispatch` (private) | Routes `*.vitecloud.app` to user workers + R2 assets   |
| `packages/create-vite-cloud` | `create-vite-cloud`              | `npm create vite-cloud` scaffolding CLI                |
| `playground/spa`             | (private)                        | SPA playground (routing, middleware, migrations, jobs) |
| `playground/ssr`             | (private)                        | SSR playground (`src/main.ssr.ts`)                     |

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
  runtime/
    handler.ts              # defineHandler(), defineHandler.withValidator(), defineMiddleware()
    validator.ts            # runValidation() — Standard Schema body/query/params validation
    response.ts             # convertReturnValue() — return → Response
    fetch.ts                # Typed fetch client for vite-cloud/client
  inference/
    walk.ts                 # AST walking with vite's parseSync + estree-walker
  migrations/
    runner.ts               # Applies .sql files to local SQLite via better-sqlite3
    collect.ts              # Reads .sql files from migrations/ dir, sorted by filename
    validate.ts             # Destructive-op detection + pragma enforcement
  deploy/
    cli.ts                  # CLI entry: `vite-cloud deploy|link|login`
    deploy.ts               # Orchestrator: build → collect/validate migrations → package → upload
    project.ts              # Reads/creates .vite-cloud/project.json
    auth.ts                 # Token read/save + runLogin() (local server + browser OAuth)
    login.ts                # Login command UI (@clack/prompts)
    package.ts              # Packages dist/ into FormData (worker + assets + migrations + manifest)
    client.ts               # HTTP client for platform API
    types.ts                # DeployManifest, MigrationMeta types
```

### Key Design Decisions

- **`parseSync` comes from `vite`** (not `oxc-parser` directly). Vite 8 re-exports it.
- **Hono** is the runtime framework (~14KB, CF Workers native). Generated code creates a `new Hono()` app, registers middleware with `app.use()`, and registers routes with `app.get()` / `app.post()` / etc.
- **Virtual modules**: `virtual:vite-cloud-routes` holds the Hono app. A real file `.vite-cloud/entry.ts` is generated as the CF plugin entrypoint (re-exports the virtual module's app).
- **Generated `.vite-cloud/` files**: The routing plugin eagerly generates `entry.ts` and `tsconfig.json` at plugin creation time (before hooks fire). `routes.d.ts` is generated at `buildStart` and on file changes. The generated `tsconfig.json` uses `"files": ["routes.d.ts"]` so users can extend it from their root tsconfig without manual `include` entries.
- **Standard Schema types inlined**: `src/standard-schema.ts` contains the Standard Schema V1 types copied from the spec. The generated `routes.d.ts` also inlines a minimal subset. No `@standard-schema/spec` dependency is needed — users only need their chosen schema library (zod, valibot, arktype, etc.).
- **Import redirection**: The routing plugin's `resolveId` hook redirects bare `"vite-cloud"` imports to `vite-cloud/handler` (the lightweight subpath). Without this, route files pull the entire plugin (vite, @cloudflare/vite-plugin, lightningcss) into the Worker bundle. Uses `import.meta.resolve()` to compute absolute paths at plugin init.
- **Pre-resolved paths in codegen**: Generated virtual module code uses absolute paths for `hono` and `vite-cloud/response` (resolved via `import.meta.resolve()`). Virtual modules have no filesystem location, so bare specifiers can't resolve from them.
- **CF plugin API**: Worker config (`main`, `d1_databases`, `kv_namespaces`, `r2_buckets`) goes inside the `config` option of `cloudflare()`, NOT as top-level properties. `persistState` takes `{ path: string }`, not a raw string. The `config` option uses a **function form** `(resolved: WorkerConfig) => Partial<WorkerConfig>` so that bindings from the user's `wrangler.json` (if present) take precedence over inferred placeholder bindings.
- **Raw Cloudflare deployment**: Users can deploy directly to their own CF account (bypassing the Vite Cloud platform) by adding a `wrangler.json` with real binding IDs and running `vite build && wrangler deploy`. The `mergeBindings` config function in `index.ts` checks the resolved config from the user's wrangler file and only adds placeholder bindings for inferred bindings that are missing.
- **Binding inference** runs synchronously in the `viteCloud()` body (before plugin init) using `readFileSync` + `parseSync`. Looks for `*.env.DB`, `*.env.KV`, `*.env.STORAGE` member expressions.
- **Env naming**: Uses standard CF uppercase convention. `c.env.DB`, `c.env.KV`, `c.env.STORAGE`. No mapping layer needed.
- **Named method exports**: Route files export named HTTP methods (`export const GET`, `export const POST`, etc.). The scanner uses `detect-exports.ts` (via `parseSync`) to discover which methods each file exports. Each file maps to one URL pattern; multiple methods per file are supported.
- **Route handlers** use lazy `import()` for code splitting. Middleware is eagerly imported.
- **Migration DB path**: Miniflare stores D1 data at a deterministic path computed from the `database_id` using HMAC-SHA256. The `getMiniflareDatabasePath()` function in `migrations/runner.ts` replicates this algorithm so migrations target the correct SQLite file at `.vite-cloud/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`.

### Package Exports

| Subpath                | What                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `vite-cloud`           | `viteCloud()` default export + `defineHandler` + `defineMiddleware` + `CloudContext` type |
| `vite-cloud/handler`   | `defineHandler()`, `defineHandler.withValidator()`, `defineMiddleware()`, types           |
| `vite-cloud/response`  | `convertReturnValue()`                                                                    |
| `vite-cloud/validator` | `runValidation()`, `ValidatorSlots`, `HandlerInput` types                                 |
| `vite-cloud/routes`    | Empty `RouteMap` stub interface (augmented by generated `routes.d.ts`)                    |
| `vite-cloud/client`    | Typed `fetch()` client + `FetchError`                                                     |
| `vite-cloud/env`       | Global Cloudflare env types (`D1Database`, `KVNamespace`, `R2Bucket`)                     |

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
  index.ts                  # Hono app mounting route groups + auth middleware
  env.ts                    # PlatformEnv type (D1, R2, KV, DISPATCH, secrets, Variables)
  types.ts                  # User, Project, Deployment, Resource, DeployManifest
  id.ts                     # generateId(prefix) → "proj_a1b2c3d4e5f6"
  db.ts                     # Typed D1 query wrappers (CRUD for all tables)
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
migrations/
  0001_initial.sql          # users, projects, deployments, resources tables
  0002_provider_auth.sql    # Migrate users to provider-agnostic schema
```

### Auth Flow

`GET /auth/login?redirect=http://localhost:{port}/callback&provider=github|google` → HMAC-signed state (includes `provider`) → GitHub or Google OAuth → `GET /auth/callback` → extract `provider` from state → exchange code → upsert user (with duplicate email check across providers) → sign JWT → redirect to CLI with `?token=`.

The CLI's `vcd login` prompts user to choose GitHub or Google, then passes `provider` in the query string. On email conflict (same email registered under different provider), the callback redirects with `?error=email_conflict&existing_provider=...`.

The `User` type uses provider-agnostic columns: `provider` (`"github"` | `"google"`), `provider_id` (TEXT — GitHub numeric ID cast to string, Google opaque sub), `login` (GitHub username or Google email).

Auth middleware on `/projects/*` extracts Bearer token, verifies JWT, sets `c.get("userId")` and `c.get("userLogin")`. Deploy endpoint checks `project.user_id === c.get("userId")` for ownership.

### Deploy Endpoint Flow

`POST /projects/:id/deploy` receives multipart form data:

1. Ownership check: `project.user_id` must match authenticated user
2. Provision bindings (D1, KV, R2) — creates CF resources if needed
3. `migration:<name>` fields → validated, then executed on D1 via CF REST API (status: `"migrating"`)
4. `asset:<path>` fields → stored in R2 at `{projectId}/current/{path}`
5. `worker:<path>` fields → uploaded to CF dispatch namespace via API
6. KV routing updated: `slug → { workerName, projectId }`
7. Deployment marked as `live`

**Key invariant:** Worker is never deployed unless all migrations succeed. On migration failure, deployment is marked `"failed"` and the existing worker keeps running.

### Secrets (via `wrangler secret put`)

`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

Optional env var: `AUTH_REDIRECT_URI` (defaults to `https://api.vite.cloud/auth/callback`). For local dev, set in `.dev.vars`.

## `dispatch` Architecture

CF Worker routing `*.vitecloud.app` traffic to user workers and static assets. No framework — plain `fetch` handler.

### Request Flow

1. Extract slug from hostname (`{slug}.vitecloud.app`)
2. KV lookup: `slug → { workerName, projectId }`
3. `/api/*` → `env.DISPATCH.get(workerName).fetch(request)` (Workers for Platforms)
4. Everything else → serve static assets from R2 (SPA fallback to `index.html`)

### Source Layout

```
src/
  index.ts                  # Main fetch handler
  env.ts                    # Env interface (DISPATCH, ASSETS, ROUTING)
  hostname.ts               # extractSlug() — pure function
  static.ts                 # serveStaticAsset() — R2 lookup, SPA fallback, cache headers
```

### Static Asset Serving

- Hashed assets (`assets/*-<hash>.js`) get `Cache-Control: public, max-age=31536000, immutable`
- `index.html` gets `Cache-Control: no-cache`
- Non-file paths fall back to `index.html` (SPA routing)

## Tooling

| Tool     | Version       | Purpose                                   |
| -------- | ------------- | ----------------------------------------- |
| pnpm     | 10.x          | Package manager with workspaces + catalog |
| tsdown   | 0.20.3        | Build (rolldown-based, ESM, DTS)          |
| wrangler | 4.x           | CF Worker dev/deploy (platform, dispatch) |
| vitest   | 4.x           | Unit + integration tests                  |
| oxlint   | 1.47.x        | Linting                                   |
| oxfmt    | 0.32.x        | Formatting (double quotes, semis)         |
| vite     | 8.0.0-beta.14 | Dev server + build                        |

## Testing

Tests run from root with `pnpm test` (vitest). 310 tests across 40 files.

### Unit Tests

| Test file                                                      | Covers                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/vite-cloud/test/unit/parse-filename.test.ts`         | Route filename parsing (21 tests)                              |
| `packages/vite-cloud/test/unit/scan.test.ts`                   | Filesystem scanning (8 tests)                                  |
| `packages/vite-cloud/test/unit/detect-exports.test.ts`         | Named HTTP method export detection (8 tests)                   |
| `packages/vite-cloud/test/unit/compile.test.ts`                | Code generation (7 tests)                                      |
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
| `packages/dispatch/test/unit/hostname.test.ts`                 | Slug extraction from hostname (12 tests)                       |
| `packages/platform/test/unit/provision.test.ts`                | Binding provisioning engine (7 tests)                          |
| `packages/platform/test/unit/jwt.test.ts`                      | JWT sign/verify round-trip (5 tests)                           |
| `packages/platform/test/unit/remote-runner.test.ts`            | Remote D1 migration execution (7 tests)                        |

### Integration Tests

Platform integration tests call the Hono app via `app.fetch(request, env)` with **real** Miniflare D1/KV/R2 bindings and **mocked** external fetch calls (GitHub API, CF API). This tests the full request→middleware→route→DB→response chain.

| Test file                                                 | Covers                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/platform/test/integration/api-health.test.ts`   | Health endpoint smoke test (1 test)                                         |
| `packages/platform/test/integration/api-me.test.ts`       | Auth middleware: missing/invalid/expired JWT, valid (4)                     |
| `packages/platform/test/integration/api-projects.test.ts` | Projects CRUD: auth, list, create, validation, dupes (7)                    |
| `packages/platform/test/integration/api-deploy.test.ts`   | Deploy pipeline: auth, provisioning, migrations, R2, KV, failure modes (12) |

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
- Middleware: `middleware/01.logger.ts` (uses `defineMiddleware`)
- Migration: `migrations/001_create_users.sql` (creates users table + seeds data)
- Seamless tsconfig: `tsconfig.json` extends `.vite-cloud/tsconfig.json` for auto type discovery

`playground/ssr` is a minimal React SSR app demonstrating `src/main.ssr.ts` render fallback plus API routes.

Verified working:

- `cd playground/spa && pnpm dev`
- `cd playground/ssr && pnpm dev`
- `cd playground/spa && pnpm typecheck` (includes typed routes via generated `.vite-cloud/routes.d.ts`)

## Pitfalls / Things That Broke

- **tsdown 0.20.3** outputs `.mjs`/`.d.mts` extensions — package.json exports must match.
- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
- **Miniflare D1 `exec()` with multi-statement SQL** fails with `Cannot read properties of undefined (reading 'duration')`. Split into individual statements and use `db.batch(stmts.map(s => db.prepare(s)))` instead.
- **ArkType `ArkErrors.map()` returns `ArkErrors`** (not a plain array), causing `Response.json()` serialization to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead of `issues.map(mapper)` when flattening Standard Schema issues.
- **Standard Schema V1 types are inlined**, not imported from `@standard-schema/spec`. The spec explicitly allows this. Keeps the generated `routes.d.ts` self-contained and avoids requiring users to install the spec package.
- **tsconfig `extends` does NOT merge `include`/`files`** — the child completely replaces the parent's. To make generated types discoverable, the `.vite-cloud/tsconfig.json` uses `"files"` (inherited when the child doesn't specify `files`) rather than `"include"` (overridden by the child's `include`).
