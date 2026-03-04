# Lessons

## Worktrees + Submodules: How to merge back to root tree

**Problem:** A submodule pointer is a specific commit SHA. Committing the framework change in the worktree (on a detached HEAD) produces a SHA that only exists there. When you try to merge the platform branch back to main, `git submodule update` fails because the referenced commit doesn't exist in main's framework object store or the remote.

**Solution:** Get the changeset from each commit and manually re-apply them to the the framework submodule in root.

## Configuration Changes Checklist

After any change that modifies the configuration options (`void.json`), make sure to:

- Update `framework/packages/void/schema.json`
- Update public-facing docs (`framework/docs/config.md`)
- Update anything else relevant (e.g. types, validation, README references)

## Drizzle Migration Tracking (push → migrate transition)

**Problem:** `drizzle-kit push` creates tables directly without recording entries in the `drizzle.__drizzle_migrations` tracking table. When switching to `drizzle-kit migrate` (which CI uses), it tries to re-run all migrations because it doesn't know the schema already exists.

**Solution:** Seed the tracking table manually:

```sql
CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('<migration_tag>', <when_timestamp>);
```

The `hash` and `created_at` values come from `drizzle/meta/_journal.json`.

## CJS require() in Cloudflare Workers (Vite/Rolldown bundling)

**Problem:** CJS packages like `pg` use `require("events")` etc. When bundled by Vite/Rolldown for a CF Worker, Rolldown wraps these in `__require()` which fails at runtime because Workers don't have `require()` (even with `nodejs_compat`). The `@cloudflare/vite-plugin`'s built-in `esmExternalRequirePlugin` should handle this but doesn't apply correctly when the environment name doesn't match.

**Solution:** Add `esmExternalRequirePlugin` explicitly to the worker environment's Rolldown plugins in `vite.config.ts`. The environment name matches the wrangler worker name (e.g. `void_dashboard`), NOT `"ssr"`.

```ts
import { builtinModules } from "node:module";
import { esmExternalRequirePlugin } from "vite";
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);
// in defineConfig:
environments: {
  void_dashboard: {
    build: {
      rolldownOptions: {
        plugins: [esmExternalRequirePlugin({ external: nodeBuiltins, skipDuplicateCheck: true })];
      }
    }
  }
}
```

## Schema Backward Compatibility During Deploy

**Problem:** `drizzle-kit migrate` runs BEFORE the new worker deploys. Old code briefly runs against the new schema. Breaking migrations (renames, drops, type changes) crash production in this window.

**Solution:** `schema-compat` CI job in `.github/workflows/ci.yml` applies PR migrations to real PostgreSQL, then runs `prod` branch tests against it.

**Safe patterns:** add nullable column, add table, add index.
**Unsafe (two-phase required):** rename column, drop column, change type.

**Test infra:** `VOID_TEST_DATABASE_URL` env var switches integration tests from PGlite to real PostgreSQL. `fileParallelism: false` prevents data races in this mode. Uses a non-standard name to prevent accidental data loss if `DATABASE_URL` is set globally (e.g. for Drizzle migrations).

## Cloudflare Analytics Engine SQL Quirks

AE SQL is ClickHouse-based with several non-obvious limitations:

1. **`timestamp` must be in SELECT** — If you reference the built-in `timestamp` column in WHERE or ORDER BY, you must also include it in the SELECT clause. Otherwise: `unable to find type of column: "timestamp"`.
2. **No `SELECT DISTINCT`** — Use `GROUP BY` instead.
3. **No auto-cast string→DateTime** — `timestamp >= '2026-01-01 00:00:00'` fails with "cannot combine DateTime and String types". Use `timestamp >= toDateTime('...')`.
4. **Don't alias over `timestamp`** — `double1 as timestamp` shadows the built-in column, causing type errors in WHERE clauses. Use a different alias like `ts`.
5. **DateTime format** — Use `YYYY-MM-DD HH:MM:SS` (no milliseconds, no `T`, no `Z`). Trim with `.toISOString().replace("T", " ").slice(0, 19)`.
