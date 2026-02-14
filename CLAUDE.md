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

Phase 1 (local dev) is implemented. The core plugin, scaffolding CLI, and playground app are built. No integration tests with workerd yet — only unit tests (56 tests across 5 files). The playground builds but has not been fully tested end-to-end with `vite dev` (the CF plugin integration may need iteration).

## Monorepo Structure

pnpm workspaces. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (typescript, tsdown, vite, @cloudflare/vite-plugin).

| Package | npm name | Purpose |
|---------|----------|---------|
| `packages/vite-plugin-cloud` | `vite-plugin-cloud` | Core Vite plugin — routing, inference, migrations |
| `packages/create-vite-cloud` | `create-vite-cloud` | `npm create vite-cloud` scaffolding CLI |
| `playground/` | (private) | Dev/test app exercising all features |

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
- **Binding inference** runs synchronously in the `viteCloud()` body (before plugin init) using `readFileSync` + `parseSync`. Looks for `*.env.db`, `*.env.kv`, `*.env.storage` member expressions.
- **Env mapping**: CF plugin bindings use uppercase (`DB`, `KV`, `STORAGE`). User code uses lowercase via `ctx.env.db`, `ctx.env.kv`, `ctx.env.storage`. The `createRequestContext` function maps between them.
- **Route handlers** use lazy `import()` for code splitting. Middleware is eagerly imported.

### Package Exports

| Subpath | What |
|---------|------|
| `vite-plugin-cloud` | `viteCloud()` default export + `defineHandler` + `RequestContext` type |
| `vite-plugin-cloud/handler` | `defineHandler()` standalone |
| `vite-plugin-cloud/context` | `createRequestContext()` + `RequestContext` type |
| `vite-plugin-cloud/response` | `convertReturnValue()` |

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

| Tool | Version | Purpose |
|------|---------|---------|
| pnpm | 10.x | Package manager with workspaces + catalog |
| tsdown | 0.20.3 | Build (rolldown-based, ESM, DTS) |
| vitest | 4.x | Unit tests |
| oxlint | 1.47.x | Linting |
| oxfmt | 0.32.x | Formatting (double quotes, semis) |
| vite | 8.0.0-beta.14 | Dev server + build |

## Testing

Unit tests live in `packages/vite-plugin-cloud/test/unit/`. Run from root with `pnpm test`.

| Test file | Covers |
|-----------|--------|
| `parse-filename.test.ts` | Route filename parsing (30 tests) |
| `scan.test.ts` | Filesystem scanning (5 tests) |
| `compile.test.ts` | Code generation (3 tests) |
| `response.test.ts` | Return value → Response conversion (8 tests) |
| `inference.test.ts` | AST-based binding inference (10 tests) |

## Playground

`playground/` is a React SPA with API routes demonstrating:
- Static route: `routes/api/hello.get.ts`
- CRUD routes: `routes/api/users/index.get.ts`, `index.post.ts`, `[id].get.ts`
- Middleware: `middleware/01.logger.ts`
- Migration: `migrations/001_create_users.sql` (creates users table + seeds data)
