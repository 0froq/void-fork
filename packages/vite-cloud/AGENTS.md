# vite-cloud

Core Vite plugin — routing, inference, migrations, CLI.

## Architecture

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

## Tests

| Test file                                  | Covers                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| `test/unit/parse-filename.test.ts`         | Route filename parsing (21 tests)                              |
| `test/unit/scan.test.ts`                   | Filesystem scanning (8 tests)                                  |
| `test/unit/detect-exports.test.ts`         | Named HTTP method export detection (8 tests)                   |
| `test/unit/compile.test.ts`                | Code generation (5 tests)                                      |
| `test/unit/response.test.ts`               | Return value → Response (8 tests)                              |
| `test/unit/inference.test.ts`              | AST-based binding inference (11 tests)                         |
| `test/unit/validate-migrations.test.ts`    | Destructive-op detection + pragma (12 tests)                   |
| `test/unit/collect-migrations.test.ts`     | Migration file collection (4 tests)                            |
| `test/unit/validator.test.ts`              | Standard Schema validation runtime (8 tests)                   |
| `test/unit/validator-real-schemas.test.ts` | Real schema validation (zod/valibot/arktype) (16 tests)        |
| `test/unit/define-handler.test.ts`         | defineHandler + middleware composition (18 tests)              |
| `test/unit/fetch.test.ts`                  | Typed fetch client (9 tests)                                   |
| `test/unit/route-types.test.ts`            | Route type codegen output (6 tests)                            |
| `test/unit/route-type-extraction.test.ts`  | Type extraction pipeline (Serialize + ExtractInput) (14 tests) |
| `test/unit/schema.test.ts`                 | SQL DDL parser (41 tests)                                      |
| `test/unit/db-types.test.ts`               | DB type codegen output (8 tests)                               |
| `test/unit/db.test.ts`                     | Typed query client + type-level inference (25 tests)           |
