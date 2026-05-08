# Lessons

## Operating Rules

- Worktrees: create real git worktrees with `git worktree add` under `.worktrees/`. Do not apply worktree changes back to the main tree without explicit user confirmation.
- Design/doc work: stay in design mode until the user asks for implementation. If a feature is not live yet, prefer a clean cutover over legacy migration work.
- Docs/progress: code is the source of truth, but public docs may intentionally omit paused features. Describe root scripts exactly as implemented; root `dev` and `build` are dashboard-only. Track "implemented", "shipped", and "done" separately unless the user says they are equivalent.
- Commands: avoid HEREDOC commit messages with apostrophes; run `pnpm test <path-or-pattern>` without `--`; in `framework/`, use `pnpm build:all` for a full build.

## Framework And Schema

- `void.json` changes must update `framework/packages/void/schema.json`, `framework/docs/config.md`, and related types, validation, or README references.
- Framework DX: preserve existing CLI namespaces, prefer conventions over config, keep advanced hooks as escape hatches, and document clean-break surfaces without migration notes unless asked.
- Adapter/package surfaces: keep runtime APIs at package roots and move Vite plugin factories to explicit `/plugin` subpaths.
- `drizzle-kit push` to `migrate`: seed `drizzle.__drizzle_migrations` from `drizzle/meta/_journal.json` before switching modes.
- Drizzle helpers: on `drizzle-orm@0.45.x`, use `drizzle-zod`, `drizzle-valibot`, and `drizzle-arktype`; infer validators from `db/schema.ts` via `void/drizzle-valibot` and import them from `@schema`.
- SQLite PRAGMA: use bare names or single-quoted strings for `PRAGMA table_info(...)` and `PRAGMA index_list(...)`; do not use double-quoted identifiers.
- Dual SQLite/Postgres paths: keep dialect-specific imports in dialect-specific modules so Workers bundles do not pull `pg` into SQLite/D1 code.
- Schema deploy safety: migrations must be backward compatible while old code may still run. Additive changes are safe; renames, drops, and type changes need a two-phase rollout. Use `VOID_TEST_DATABASE_URL` for real-Postgres checks and keep `fileParallelism: false`.

## Cloudflare And Deploys

- Workers + CJS bundling: add `esmExternalRequirePlugin` to the actual worker environment in `vite.config.ts`; the env name is the Wrangler worker name, not `"ssr"`.
- Analytics Engine SQL: include `timestamp` when filtering or sorting on it, use `GROUP BY` instead of `DISTINCT`, cast with `toDateTime(...)`, avoid aliasing over `timestamp`, and format datetimes as `YYYY-MM-DD HH:MM:SS`.
- Deploy manifests: `packageBuild` and `packageFrameworkBuild` must include the database binding whenever `bindings.needsD1 || bindings.needsAuth || hasMigrations`.
- Deploy cancellation/dedupe: cancellation is two-phase and must stay blocking until cleanup completes. Only skip worker deploys when worker module hashes are part of the comparison.
- Deploy asset handling: verify client-declared blob hashes against uploaded bytes, stream multipart bodies in the API Worker, and keep the CF WfP cache-buster, early `asset_hashes` persistence, and KV/R2 mirror fallback from design doc 0066.
- API compatibility: dashboard deploys after the platform deploy in the same pipeline, so API changes must stay backward compatible with the currently live dashboard and forward compatible with the dashboard about to deploy. Do not make backwards-incompatible API changes without a staged rollout.
- Staging access: CI must set `VOID_API_URL=https://api.staging.void.cloud`; `STAGING=1` is not enough. Staging hosts require Cloudflare Access credentials via `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` or `CF_ACCESS_TOKEN`; OAuth callbacks stay Access-bypassed.
- WfP DO namespace lookup: do not poll account-wide DO namespace lists. Use `GET /workers/dispatch/namespaces/{ns}/scripts/{script}/bindings` and read the binding `namespace_id`.
- WfP DO dispatch: do not call service-binding `.fetch` from inside a `DurableObject` or `WorkerEntrypoint` subclass; enqueue to a Queue or dispatch from a non-DO worker instead.
- Cron sync: run cron DO `/sync` or `/clear` only after routing has switched so pre-cutover deploy failures cannot disable the previous live deployment's crons.
- Container provisioning: the platform must create container applications itself, POST with `durable_objects.namespace_id`, omit immutable fields on PATCH, treat 409 as concurrent create, and verify namespace matches before PATCH.
- WfP container lifecycle: WfP scripts cannot cross-bind to each other with `script_name`, so the platform uses per-deploy container DO ownership. One DO namespace can back at most one container app, and deleting a WfP script does not delete the app; cleanup must delete container apps explicitly.
- DO migrations: preserve chronological migration tag order across features and use configured class/binding names. On re-PUT, read nested `script.migration_tag`; if it already equals the target, omit `migrations` because resending the same `new_tag` returns CF 10079.

## Product Surfaces

- `void project logs`: Cloudflare Tail only sees top-level `console.*` and uncaught throws. Surface caught app errors with `console.error` or `void/log` `logger.error(...)`. `--filter` is message substring search; use `--level` for severity filtering.
- Production-backed local dashboard testing: production may not yet expose new API fields. Prefer a localhost-only access bypass over committed or ad hoc allowlists.
- Dashboard Worker local env: if `packages/dashboard/.dev.vars` exists, put local Worker vars such as `API_URL` and `SITE_DOMAIN` there or in `wrangler.jsonc` vars.
- Dashboard Tailwind colors: `packages/ui/src/styles/tokens.css` resets the palette with `--color-*: initial`; define needed scales in `@theme` before using utilities such as `bg-gray-*`.
- Requests Analytics Engine queries should consistently key projects by `blob1`; dispatch also writes `index1`, but billing and top-traffic queries use `blob1`, so dashboard traffic summaries should match that established path.
- Dashboard marketing shells: use a column `min-h-screen` layout with the page area as `flex-1`, so `FooterNav` sits at the viewport bottom. Keep shared `.wrapper` at `w-full` because flex children with `mx-auto` can otherwise shrink to their content. When page content is shorter than the viewport, fill the leftover middle slot with a flexible empty `.wrapper` so the side borders continue down to the footer.
