This is the development repo of Vite Cloud.

Refer to the [Design Doc](./design.md) for the high-level vision and architecture. This file describes the current state of the codebase.

## Quick Reference

```
pnpm -r build       # Build all packages
pnpm test            # Run vitest (unit tests only for now)
pnpm lint            # oxlint
pnpm fmt             # oxfmt --write .
```

Make sure to run `lint` and `fmt` after major changes.

## Status

Phase 1 (local dev) is complete. Phase 2 Steps 1–5 (platform, dispatch, deploy CLI) are implemented — stateless deploy works. Step 7 (binding provisioning) and Step 8 (GitHub OAuth auth + `vite-cloud login`) are done. Remote migrations and runtime inference remain.

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (typescript, tsdown, vite, @cloudflare/workers-types, wrangler).

| Package                      | npm name                         | Purpose                                                |
| ---------------------------- | -------------------------------- | ------------------------------------------------------ |
| `packages/vite-cloud`        | `vite-cloud`                     | Core Vite plugin — routing, inference, migrations, CLI |
| `packages/platform`          | `@vite-cloud/platform` (private) | Control Plane API — projects, deploys, CF API proxy    |
| `packages/dispatch`          | `@vite-cloud/dispatch` (private) | Routes `*.vitecloud.app` to user workers + R2 assets   |
| `packages/create-vite-cloud` | `create-vite-cloud`              | `npm create vite-cloud` scaffolding CLI                |
| `playground/`                | (private)                        | Dev/test app exercising all features                   |

## `vite-cloud` Architecture

The main export `viteCloud()` returns an array of Vite plugins + the `cloudflare()` plugin:

```
viteCloud() → [routingPlugin, migrationPlugin, cloudflare({...inferredBindings})]
```

### Runtime Framework

**Hono** is used as the runtime framework. The generated virtual module creates a Hono app with file-based routes and middleware. Route handlers receive a Hono `Context` object (`c`) and can use the full Hono API (`c.json()`, `c.text()`, `c.req.param()`, etc.) plus the Hono middleware ecosystem.

- `defineHandler(fn)` — wraps a route handler `(c: CloudContext) => unknown`
- `defineMiddleware(fn)` — wraps Hono middleware `(c, next) => void`
- Handlers can return plain objects/strings (auto-converted via `convertReturnValue`) or use Hono's `c.json()` / `c.text()` directly.

### Source Layout

```
src/
  index.ts                  # Main export: viteCloud() → Plugin[]
  plugin-routing.ts         # Virtual module resolution, file watching, HMR
  plugin-inference.ts       # Binding inference orchestration (calls walk.ts)
  plugin-migration.ts       # Local migration runner on dev startup
  router/
    parse-filename.ts       # Route filename → RouteDefinition (pure function)
    scan.ts                 # Filesystem scanner using tinyglobby
    compile.ts              # Generates Hono app code + worker entry
  runtime/
    handler.ts              # defineHandler(), defineMiddleware() — identity functions with types
    response.ts             # convertReturnValue() — return → Response
  inference/
    walk.ts                 # AST walking with vite's parseSync + estree-walker
  migrations/
    runner.ts               # Applies .sql files to local SQLite via better-sqlite3
  deploy/
    cli.ts                  # CLI entry: `vite-cloud deploy|link|login`
    deploy.ts               # Orchestrator: build → package → upload → print URL
    project.ts              # Reads/creates .vite-cloud/project.json
    auth.ts                 # Token read/save + runLogin() (local server + browser OAuth)
    login.ts                # Login command UI (@clack/prompts)
    package.ts              # Packages dist/ into FormData (worker + assets + manifest)
    client.ts               # HTTP client for platform API
    types.ts                # DeployManifest type
```

### Key Design Decisions

- **`parseSync` comes from `vite`** (not `oxc-parser` directly). Vite 8 re-exports it.
- **Hono** is the runtime framework (~14KB, CF Workers native). Generated code creates a `new Hono()` app, registers middleware with `app.use()`, and registers routes with `app.get()` / `app.post()` / etc.
- **Virtual modules**: `virtual:vite-cloud-routes` holds the Hono app. A real file `.vite-cloud/entry.ts` is generated as the CF plugin entrypoint (re-exports the virtual module's app).
- **Import redirection**: The routing plugin's `resolveId` hook redirects bare `"vite-cloud"` imports to `vite-cloud/handler` (the lightweight subpath). Without this, route files pull the entire plugin (vite, @cloudflare/vite-plugin, lightningcss) into the Worker bundle. Uses `import.meta.resolve()` to compute absolute paths at plugin init.
- **Pre-resolved paths in codegen**: Generated virtual module code uses absolute paths for `hono` and `vite-cloud/response` (resolved via `import.meta.resolve()`). Virtual modules have no filesystem location, so bare specifiers can't resolve from them.
- **CF plugin API**: Worker config (`main`, `d1_databases`, `kv_namespaces`, `r2_buckets`) goes inside the `config` option of `cloudflare()`, NOT as top-level properties. `persistState` takes `{ path: string }`, not a raw string.
- **Binding inference** runs synchronously in the `viteCloud()` body (before plugin init) using `readFileSync` + `parseSync`. Looks for `*.env.DB`, `*.env.KV`, `*.env.STORAGE` member expressions.
- **Env naming**: Uses standard CF uppercase convention. `c.env.DB`, `c.env.KV`, `c.env.STORAGE`. No mapping layer needed.
- **Route handlers** use lazy `import()` for code splitting. Middleware is eagerly imported.
- **Migration DB path**: Miniflare stores D1 data at a deterministic path computed from the `database_id` using HMAC-SHA256. The `getMiniflareDatabasePath()` function in `migrations/runner.ts` replicates this algorithm so migrations target the correct SQLite file at `.vite-cloud/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`.

### Package Exports

| Subpath               | What                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `vite-cloud`          | `viteCloud()` default export + `defineHandler` + `defineMiddleware` + `CloudContext` type |
| `vite-cloud/handler`  | `defineHandler()`, `defineMiddleware()`, `CloudContext`, `CloudEnv` types                 |
| `vite-cloud/response` | `convertReturnValue()`                                                                    |

The CLI binary is at `dist/deploy/cli.mjs` (declared in `bin` field of package.json).

Build output uses `.mjs` / `.d.mts` extensions (tsdown 0.20.3 default).

### Route Filename Parsing Rules

Applied in order to a path relative to `routes/`:

1. Strip extension (`.ts`, `.js`, `.mts`, `.mjs`)
2. Strip env suffix (`.dev`, `.prod`)
3. Strip HTTP method suffix (`.get`, `.post`, `.put`, `.delete`, `.patch`) — default `*`
4. Strip trailing `index`
5. Remove route group dirs `(groupname)`
6. Convert `[param]` → `:param`, `[...param]` → `**:param`, `[...]` → `**`
7. Prefix with `/`

Files/dirs starting with `_` are ignored by the scanner.

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
  middleware/
    auth.ts                 # Bearer token verification, sets userId/userLogin on context
  routes/
    auth.ts                 # GET /auth/login + GET /auth/callback (GitHub OAuth flow)
    projects.ts             # POST /projects, GET /projects/:id
    deploy.ts               # POST /projects/:id/deploy (multipart upload + ownership check)
migrations/
  0001_initial.sql          # users, projects, deployments, resources tables
```

### Auth Flow

`GET /auth/login?redirect=http://localhost:{port}/callback` → HMAC-signed state → GitHub OAuth → `GET /auth/callback` → exchange code → upsert user → sign JWT → redirect to CLI with `?token=`.

Auth middleware on `/projects/*` extracts Bearer token, verifies JWT, sets `c.get("userId")` and `c.get("userLogin")`. Deploy endpoint checks `project.user_id === c.get("userId")` for ownership.

### Deploy Endpoint Flow

`POST /projects/:id/deploy` receives multipart form data:

1. Ownership check: `project.user_id` must match authenticated user
2. `asset:<path>` fields → stored in R2 at `{projectId}/current/{path}`
3. `worker:<path>` fields → uploaded to CF dispatch namespace via API
4. KV routing updated: `slug → { workerName, projectId }`
5. Deployment marked as `live`

### Secrets (via `wrangler secret put`)

`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

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
| vitest   | 4.x           | Unit tests                                |
| oxlint   | 1.47.x        | Linting                                   |
| oxfmt    | 0.32.x        | Formatting (double quotes, semis)         |
| vite     | 8.0.0-beta.14 | Dev server + build                        |

## Testing

Unit tests run from root with `pnpm test` (vitest). 80 tests across 8 files.

| Test file                                              | Covers                                   |
| ------------------------------------------------------ | ---------------------------------------- |
| `packages/vite-cloud/test/unit/parse-filename.test.ts` | Route filename parsing (30 tests)        |
| `packages/vite-cloud/test/unit/scan.test.ts`           | Filesystem scanning (5 tests)            |
| `packages/vite-cloud/test/unit/compile.test.ts`        | Code generation (3 tests)                |
| `packages/vite-cloud/test/unit/response.test.ts`       | Return value → Response (8 tests)        |
| `packages/vite-cloud/test/unit/inference.test.ts`      | AST-based binding inference (10 tests)   |
| `packages/dispatch/test/unit/hostname.test.ts`         | Slug extraction from hostname (12 tests) |
| `packages/platform/test/unit/provision.test.ts`        | Binding provisioning engine (7 tests)    |
| `packages/platform/test/unit/jwt.test.ts`              | JWT sign/verify round-trip (5 tests)     |

## Playground

`playground/` is a React SPA with API routes demonstrating:

- Static route: `routes/api/hello.get.ts`
- CRUD routes: `routes/api/users/index.get.ts`, `index.post.ts`, `[id].get.ts`
- Middleware: `middleware/01.logger.ts` (uses `defineMiddleware`)
- Migration: `migrations/001_create_users.sql` (creates users table + seeds data)

Verified working: `cd playground && pnpm dev` → all API routes respond, D1 queries work, middleware runs.

## Pitfalls / Things That Broke

- **tsdown 0.20.3** outputs `.mjs`/`.d.mts` extensions — package.json exports must match.
- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
