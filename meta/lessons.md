# Lessons

## Worktrees: When asked to create a worktree, CREATE A WORKTREE

**Problem:** When the user asks to "create a worktree and execute the plan", you MUST create an actual git worktree. Do NOT just create a branch in the submodule directly — this modifies the user's active working tree, disrupting any other work they have in progress. This is unacceptable.

**Rule:** If the user says "create a worktree", use `git worktree add` to create an isolated workspace. No exceptions. No shortcuts. Follow the `using-git-worktrees` skill exactly.

Also, all worktrees should be created under `.worktrees/`.

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

## Git Commit Messages: Avoid Apostrophes in HEREDOC

**Problem:** Using `git commit -m "$(cat <<'EOF' ... EOF)"` fails when the message body contains apostrophes (e.g. "worker's"). Bash `eval` interprets the `'` as a shell quote delimiter instead of a literal character, causing `unexpected EOF while looking for matching` errors.

**Solution:** Use plain double-quoted `-m` and avoid apostrophes in the message, or escape them. Simpler: just rephrase to remove the apostrophe (e.g. "worker" instead of "worker's").

## pnpm test: Do NOT use `--` before args

**Problem:** `pnpm test -- some-test-file` makes vitest ignore the args that follow. You think you're running a single test file, but you're actually running the **full test suite**.

**Solution:** Run `pnpm test some-file-name` directly, without `--`. Also, `pnpm test` already includes `--run`, so don't pass that either.

```bash
# WRONG — runs full suite, ignores the filter
pnpm test -- packages/void/test/unit/mcp.test.ts

# CORRECT — runs only the matching test
pnpm test packages/void/test/unit/mcp.test.ts
```

## Cloudflare Analytics Engine SQL Quirks

AE SQL is ClickHouse-based with several non-obvious limitations:

1. **`timestamp` must be in SELECT** — If you reference the built-in `timestamp` column in WHERE or ORDER BY, you must also include it in the SELECT clause. Otherwise: `unable to find type of column: "timestamp"`.
2. **No `SELECT DISTINCT`** — Use `GROUP BY` instead.
3. **No auto-cast string→DateTime** — `timestamp >= '2026-01-01 00:00:00'` fails with "cannot combine DateTime and String types". Use `timestamp >= toDateTime('...')`.
4. **Don't alias over `timestamp`** — `double1 as timestamp` shadows the built-in column, causing type errors in WHERE clauses. Use a different alias like `ts`.
5. **DateTime format** — Use `YYYY-MM-DD HH:MM:SS` (no milliseconds, no `T`, no `Z`). Trim with `.toISOString().replace("T", " ").slice(0, 19)`.

## Docs Sweeps: Source Truth vs Intentional Omissions

**Problem:** During doc alignment work, it is easy to treat every source/docs mismatch as a bug. That causes false positives when public docs intentionally omit paused or unsupported integrations, and it also causes root-script descriptions to drift away from what the repo actually uses.

**Rule:** For documentation sweeps:

- source code is the source of truth for implemented behavior
- public docs can intentionally omit on-hold integrations; confirm before "fixing" those omissions
- root scripts must be described exactly as implemented, not as idealized monorepo commands
- in this repo specifically, root `dev` and `build` are dashboard-only unless the source changes

## Design Doc Revisions: Do Not Jump to Implementation

**Problem:** When a user is still refining or revising a design doc, it is easy to slip into implementation mode after producing a plan.

**Rule:** If the user asks to revise a design doc, stay in design/doc mode until they explicitly ask to build it. Non-mutating research is fine; code changes are not.

## Framework DX Design: Preserve Namespaces and Prefer Conventions

**Problem:** In auth design work, it is easy to invent new CLI entrypoints or expose too much configuration, even when the product already has established namespace boundaries and a convention-first philosophy.

**Rule:** When designing framework UX:

- preserve existing CLI namespace meanings (`void auth` is platform auth; app scaffolding belongs under `void gen`)
- default to convention-over-configuration for first-class features
- keep advanced hooks like `defineAuth()` as escape hatches, not the primary setup path
- if the user says a v1 surface is out of scope or wants a clean break, reflect that directly instead of carrying legacy or compatibility machinery forward by default

## Platform vs App-Owned Integrations in Design Work

**Problem:** When a later platform-managed integration is planned, it is easy to fill the gap with temporary Void-owned stubs even when the user wants the v1 story to rely on app-owned provider wiring instead.

**Rule:** If the user distinguishes between:

- v1: app-owned provider integration
- later: platform-managed integration

then the design must reflect that split directly. Do not insert a temporary platform-owned stub layer unless the user explicitly asks for it.

## Playground UI: Match the Existing Minimal Style

**Problem:** When adding a playground app, it is easy to over-design the UI and introduce unnecessary visual styling that distracts from the feature being demonstrated.

**Rule:** Playground apps should default to the same bare-minimum presentation as the existing demos like `kitchen-sink`: simple layout, light inline structure when needed, and focus on feature behavior over visual design unless the user explicitly asks for design work.
