# Open Source Split

**Date:** 2026-02-22
**Status:** Proposed

---

## Summary

Split the Vite Cloud monorepo into two repos: an open-source **framework repo** (vite-cloud plugin, CLI, framework adapters, docs) and a private **platform repo** (control plane, edge dispatch). The goal is to open-source the entire client-side DX layer while keeping the server infrastructure closed.

## Motivation

- Build community trust and adoption — developers can inspect, fork, and contribute to the tooling they depend on
- Enable third-party contributions to the CLI, plugin, codegen, and framework adapters
- Follow the proven model (Vercel/Next.js, Supabase, PlanetScale): open the client, close the server
- The API client / deploy command being open is a feature, not a risk — the value is in the platform, not the protocol

## What Moves Where

**Framework repo (open source):**

- `packages/vite-cloud` — core Vite plugin + CLI (routing, inference, migrations, codegen, deploy command, all runtime exports)
- `packages/vue` — Vue framework adapter
- `packages/react` — React framework adapter
- `packages/svelte` — Svelte framework adapter
- `packages/solid` — SolidJS framework adapter
- `packages/website` — documentation site (VitePress)
- `playground/*` — all 10 test apps (spa, ssr, vue-pages, react-pages, svelte-pages, solid-pages, queues, auth, ai, tanstack-start)
- `docs` symlink

**Platform repo (private, current repo):**

- `packages/platform` — control plane API
- `packages/dispatch` — edge router worker
- `packages/ai-proxy` — AI inference proxy worker
- `packages/dashboard` — user-facing dashboard (Vue Pages app)
- `packages/ui` — shared CSS/design tokens (used by dashboard and website)
- `meta/` — design docs, operations, progress tracking

## Architecture Validation

The split is architecturally clean — confirmed by code analysis:

- **Platform, dispatch, and ai-proxy have zero imports from `vite-cloud`**. No `from "vite-cloud"` or `from "@vite-cloud/{vue,react,svelte,solid}"` anywhere in platform/dispatch/ai-proxy source code.
- **The only cross-boundary coupling is the HTTP deploy protocol** — the CLI sends a deploy manifest to the platform API. This is a network boundary, not a code dependency.
- **No shared test utilities** between framework and platform packages.
- **Runtime subpaths are hermetic** — `handler`, `db`, `fetch`, `queues`, `auth` have zero imports from CLI or plugin code.
- **Plugins never import from CLI** — `plugin-routing`, `plugin-inference`, `plugin-migration`, `plugin-db-types` are all clean of CLI imports.
- **One trivial fix needed**: `config.ts` imports `HeaderRule` from `cli/types.ts`. Move the type to `config.ts` or a shared `types.ts`.

### Dashboard Cross-Boundary Dependency

The `dashboard` package is a special case — it lives in the platform repo but depends on framework packages:

- **`vite-cloud`** (core plugin) — used as the build tool
- **`@vite-cloud/vue`** (Vue adapter) — SSR, `Link`, `useShared`, `useRouter`
- **`@vite-cloud/platform/api`** — type-only import for API route types (BFF pattern)

Post-split, the dashboard will consume the framework packages as **published npm dependencies** rather than workspace links. This is clean — the dashboard is a consumer of the framework, not a co-dependent. The `@vite-cloud/platform/api` type import stays internal to the platform repo.

## Physical Layout

The framework repo lives inside the platform repo directory, gitignored. This enables unified local development (single Claude/editor context for cross-cutting changes) while the framework repo remains independently cloneable.

```
~/VoidZero/vite-cloud/              # platform repo (private)
├── .gitignore                      # includes framework/
├── pnpm-workspace.yaml             # platform + dispatch + ai-proxy + dashboard + ui
├── packages/platform/
├── packages/dispatch/
├── packages/ai-proxy/
├── packages/dashboard/
├── packages/ui/
├── meta/
└── framework/                      # framework repo (open source), gitignored
    ├── .git/                       # independent git history
    ├── pnpm-workspace.yaml         # self-contained workspace
    ├── pnpm-lock.yaml              # own lockfile
    ├── packages/vite-cloud/
    ├── packages/vue/
    ├── packages/react/
    ├── packages/svelte/
    ├── packages/solid/
    ├── packages/website/
    └── playground/
```

**External contributors** clone the framework repo standalone. `pnpm install && pnpm test` works without the platform repo.

**Internal development** launches from the parent directory with both repos in context. Cross-cutting changes (e.g., deploy protocol changes) edit files in both repos, tested independently.

## Git History

The framework repo preserves git history via `git filter-repo`, extracting commits that touched the framework packages. The platform repo keeps full history.

## Workspace Independence

Each repo is a fully self-contained pnpm workspace with its own:

- `pnpm-workspace.yaml` + catalog
- `pnpm-lock.yaml`
- `package.json` (scripts, devDependencies)
- `vitest.config.ts`
- `.oxlintrc.json`, `.node-version`, `.gitignore`, `.husky/`
- `.github/workflows/ci.yml`

No `pnpm overrides` or cross-workspace linking — the platform repo never imports from `vite-cloud` at code level, so there is no need for local linking.

## CI Changes

**Framework repo CI** (new):

- lint + typecheck
- Unit tests
- Integration tests (vite-cloud)
- Integration tests — pages adapters (react + vue + svelte + solid, requires playwright)

**Platform repo CI** (simplified):

- lint + typecheck
- Unit tests (platform + dispatch + ai-proxy)
- Integration tests (platform + dashboard)
- Remove pages adapter suite, remove `--filter '!website'` exclusions
- Playwright may still be needed for dashboard E2E tests

**Platform deploy workflows**: Remove docs deploy steps (`build:cli && pnpm i`, `deploy:docs`). Docs deployment will be handled from the framework repo once it has its own GitHub remote. Dashboard deploy stays in the platform workflow.

## Open Questions

- **Framework repo GitHub org/name**: e.g. `vitejs/vite-cloud`, `voidzero/vite-cloud`, or `vite-cloud/vite-cloud`?
- **Docs deployment**: Currently the platform deploy workflow deploys docs via `vcc deploy`. Post-split, the framework repo needs its own docs deploy workflow (or the platform deploy clones the framework repo).
- **npm publishing**: The framework repo will need its own publish workflow for `vite-cloud`, `@vite-cloud/vue`, `@vite-cloud/react`, `@vite-cloud/svelte`, `@vite-cloud/solid`.
- **`@vite-cloud/ui` placement**: Currently only CSS exports (theme.css, base.css). If the website also needs it, it may belong in the framework repo. If it stays platform-only (dashboard styling), it stays private. Currently only consumed by `dashboard`.
- **Dashboard framework dependency versioning**: Post-split, the dashboard will depend on published `vite-cloud` and `@vite-cloud/vue` from npm. Need to decide whether to pin versions or track latest. During active development, tracking latest with a lockfile update CI step is likely sufficient.
