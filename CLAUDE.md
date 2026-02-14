This is the development repo of Vite Cloud.

Refer to the [Design Doc](./design.md) for the high-level vision and architecture. This file describes the current state of the codebase.

## Quick Reference

```
pnpm -r build       # Build all packages
pnpm test            # Run vitest (unit tests only for now)
pnpm lint            # oxlint
pnpm fmt             # oxfmt --write .
```

## Status

Phase 1 (local dev) is implemented and working end-to-end. `vite dev` serves API routes, runs middleware, applies D1 migrations, and handles dynamic params. `vite build` produces a working Worker bundle (~7.5 KB). No integration tests with workerd yet — only unit tests (56 tests across 5 files).

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (typescript, tsdown, vite, @cloudflare/vite-plugin).

| Package                      | npm name            | Purpose                                           |
| ---------------------------- | ------------------- | ------------------------------------------------- |
| `packages/vite-plugin-cloud` | `vite-plugin-cloud` | Core Vite plugin — routing, inference, migrations |
| `packages/create-vite-cloud` | `create-vite-cloud` | `npm create vite-cloud` scaffolding CLI           |
| `playground/`                | (private)           | Dev/test app exercising all features              |

## `vite-plugin-cloud` Architecture

The main export `viteCloud()` returns an array of Vite plugins + the `cloudflare()` plugin:

```
viteCloud() → [routingPlugin, migrationPlugin, cloudflare({...inferredBindings})]
```

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
    compile.ts              # Generates virtual module code + worker entry
  runtime/
    handler.ts              # defineHandler() — identity function with types
    response.ts             # convertReturnValue() — return → Response
    context.ts              # createRequestContext() — env mapping (DB→db, etc.)
  inference/
    walk.ts                 # AST walking with vite's parseSync + oxc-walker
  migrations/
    runner.ts               # Applies .sql files to local SQLite via better-sqlite3
```

### Key Design Decisions

- **`parseSync` comes from `vite`** (not `oxc-parser` directly). Vite 8 re-exports it.
- **rou3** is used at runtime for route matching (tiny radix-tree router, ~2KB).
- **Virtual modules**: `virtual:vite-cloud-routes` holds the route table. A real file `.vite-cloud/entry.ts` is generated as the CF plugin entrypoint (imports the virtual module).
- **Import redirection**: The routing plugin's `resolveId` hook redirects bare `"vite-plugin-cloud"` imports to `vite-plugin-cloud/handler` (the lightweight subpath). Without this, route files pull the entire plugin (vite, @cloudflare/vite-plugin, lightningcss) into the Worker bundle. Uses `import.meta.resolve()` to compute absolute paths at plugin init.
- **Pre-resolved paths in codegen**: Generated virtual module code uses absolute paths for `rou3`, `vite-plugin-cloud/context`, and `vite-plugin-cloud/response` (resolved via `import.meta.resolve()`). Virtual modules have no filesystem location, so bare specifiers can't resolve from them.
- **CF plugin API**: Worker config (`main`, `d1_databases`, `kv_namespaces`, `r2_buckets`) goes inside the `config` option of `cloudflare()`, NOT as top-level properties. `persistState` takes `{ path: string }`, not a raw string.
- **Binding inference** runs synchronously in the `viteCloud()` body (before plugin init) using `readFileSync` + `parseSync`. Looks for `*.env.db`, `*.env.kv`, `*.env.storage` member expressions.
- **Env mapping**: CF plugin bindings use uppercase (`DB`, `KV`, `STORAGE`). User code uses lowercase via `ctx.env.db`, `ctx.env.kv`, `ctx.env.storage`. The `createRequestContext` function maps between them.
- **Route handlers** use lazy `import()` for code splitting. Middleware is eagerly imported.
- **Migration DB path**: Miniflare stores D1 data at a deterministic path computed from the `database_id` using HMAC-SHA256. The `getMiniflareDatabasePath()` function in `migrations/runner.ts` replicates this algorithm so migrations target the correct SQLite file at `.vite-cloud/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`.

### Package Exports

| Subpath                      | What                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| `vite-plugin-cloud`          | `viteCloud()` default export + `defineHandler` + `RequestContext` type |
| `vite-plugin-cloud/handler`  | `defineHandler()` standalone                                           |
| `vite-plugin-cloud/context`  | `createRequestContext()` + `RequestContext` type                       |
| `vite-plugin-cloud/response` | `convertReturnValue()`                                                 |

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

## Tooling

| Tool   | Version       | Purpose                                   |
| ------ | ------------- | ----------------------------------------- |
| pnpm   | 10.x          | Package manager with workspaces + catalog |
| tsdown | 0.20.3        | Build (rolldown-based, ESM, DTS)          |
| vitest | 4.x           | Unit tests                                |
| oxlint | 1.47.x        | Linting                                   |
| oxfmt  | 0.32.x        | Formatting (double quotes, semis)         |
| vite   | 8.0.0-beta.14 | Dev server + build                        |

## Testing

Unit tests live in `packages/vite-plugin-cloud/test/unit/`. Run from root with `pnpm test`.

| Test file                | Covers                                       |
| ------------------------ | -------------------------------------------- |
| `parse-filename.test.ts` | Route filename parsing (30 tests)            |
| `scan.test.ts`           | Filesystem scanning (5 tests)                |
| `compile.test.ts`        | Code generation (3 tests)                    |
| `response.test.ts`       | Return value → Response conversion (8 tests) |
| `inference.test.ts`      | AST-based binding inference (10 tests)       |

## Playground

`playground/` is a React SPA with API routes demonstrating:

- Static route: `routes/api/hello.get.ts`
- CRUD routes: `routes/api/users/index.get.ts`, `index.post.ts`, `[id].get.ts`
- Middleware: `middleware/01.logger.ts`
- Migration: `migrations/001_create_users.sql` (creates users table + seeds data)

Verified working: `cd playground && pnpm dev` → all API routes respond, D1 queries work, middleware runs.

## Pitfalls / Things That Broke

- **tsdown 0.20.3** outputs `.mjs`/`.d.mts` extensions — package.json exports must match.
- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
