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
- `playground/*` — all 8 test apps
- `docs` symlink

**Platform repo (private, current repo):**

- `packages/platform` — control plane API + admin dashboard
- `packages/dispatch` — edge router worker
- `meta/` — design docs, operations, progress tracking

## Architecture Validation

The split is architecturally clean — confirmed by code analysis:

- **Platform and dispatch have zero imports from `vite-cloud`**. No `from "vite-cloud"` or `from "@vite-cloud/{vue,react,svelte,solid}"` anywhere in platform/dispatch source code.
- **The only cross-boundary coupling is the HTTP deploy protocol** — the CLI sends a deploy manifest to the platform API. This is a network boundary, not a code dependency.
- **No shared test utilities** between framework and platform packages.
- **Runtime subpaths are hermetic** — `handler`, `db`, `fetch`, `queues`, `auth` have zero imports from CLI or plugin code.
- **Plugins never import from CLI** — `plugin-routing`, `plugin-inference`, `plugin-migration`, `plugin-db-types` are all clean of CLI imports.
- **One trivial fix needed**: `config.ts` imports `HeaderRule` from `cli/types.ts`. Move the type to `config.ts` or a shared `types.ts`.

## Physical Layout

The framework repo lives inside the platform repo directory, gitignored. This enables unified local development (single Claude/editor context for cross-cutting changes) while the framework repo remains independently cloneable.

```
~/VoidZero/vite-cloud/              # platform repo (private)
├── .gitignore                      # includes framework/
├── pnpm-workspace.yaml             # platform + dispatch only
├── packages/platform/
├── packages/dispatch/
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
- Unit tests (platform + dispatch)
- Integration tests (platform only)
- Remove playwright, remove pages adapter suite, remove `--filter '!website'` exclusions

**Platform deploy workflows**: Remove docs deploy steps (`build:cli && pnpm i`, `deploy:docs`). Docs deployment will be handled from the framework repo once it has its own GitHub remote.

## Open Questions

- **Framework repo GitHub org/name**: e.g. `vitejs/vite-cloud`, `voidzero/vite-cloud`, or `vite-cloud/vite-cloud`?
- **Docs deployment**: Currently the platform deploy workflow deploys docs via `vcc deploy`. Post-split, the framework repo needs its own docs deploy workflow (or the platform deploy clones the framework repo).
- **npm publishing**: The framework repo will need its own publish workflow for `vite-cloud`, `@vite-cloud/vue`, `@vite-cloud/react`, `@vite-cloud/svelte`, `@vite-cloud/solid`.
