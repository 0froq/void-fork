# Deploy to Raw Cloudflare — Research & Plan

## Current State

The vite-cloud framework generates a **platform-agnostic** Cloudflare Worker:

- Standard `{ fetch, scheduled }` export (Hono app)
- Uses standard CF bindings (`c.env.DB`, `c.env.KV`, `c.env.STORAGE`)
- No runtime dependency on the vite-cloud platform
- The `@cloudflare/vite-plugin` already generates a `wrangler.json` in `dist/` at build time

**The worker itself can already run on raw Cloudflare.** The gap is in the deployment tooling, not the runtime.

## What the Platform Does (That Raw CF Wouldn't)

| Concern              | Vite Cloud Platform                      | Raw Cloudflare                                                 |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Worker upload        | Workers for Platforms dispatch namespace | `wrangler deploy`                                              |
| Static assets        | R2 + dispatch worker serves them         | Workers Static Assets (built into `@cloudflare/vite-plugin`)   |
| Binding provisioning | Auto-create D1/KV/R2 via CF API          | User creates resources manually, configures in `wrangler.json` |
| Migrations           | Platform runs SQL via CF REST API        | `wrangler d1 migrations apply`                                 |
| Auth                 | OAuth + JWT via platform API             | N/A (user's own CF account)                                    |
| Routing              | `{slug}.vitecloud.app` via KV            | User's own domain / `workers.dev`                              |

## What Already Works

1. **`vite build`** produces a complete CF Worker bundle via `@cloudflare/vite-plugin`
2. **`wrangler deploy`** can deploy the build output (the plugin generates `wrangler.json` in `dist/`)
3. **Binding inference** tells us what bindings are needed
4. **Migration collection & validation** is framework-level, not platform-specific

## The Gap

`viteCloud()` currently passes **placeholder binding IDs** to `cloudflare()`:

```typescript
workerConfig.d1_databases = [
  {
    binding: "DB",
    database_name: "default",
    database_id: "local", // ← placeholder, only works for local dev
  },
];
```

For raw CF deployment, users need **real** binding IDs in their config. The `@cloudflare/vite-plugin` supports reading from a `wrangler.json`/`wrangler.toml` — but `viteCloud()` bypasses it by passing everything programmatically.

## Proposed Approach

### Core Idea

If a user has a `wrangler.json` (or `wrangler.toml`) in their project root, respect it. Merge inferred bindings (for dev) with user-provided config (for production). Users who want raw CF deployment just:

1. Create a `wrangler.json` with their real binding IDs
2. `vite build && wrangler deploy`

### Implementation

**1. Detect user's wrangler config**

In `viteCloud()`, check for `wrangler.json` / `wrangler.toml` / `wrangler.jsonc` in the project root. If found, read binding IDs from it.

**2. Merge strategy**

- **Dev mode**: Use inferred bindings with local placeholder IDs (current behavior). The `@cloudflare/vite-plugin` handles local dev via Miniflare regardless of config.
- **Build mode**: If user has a wrangler config, let it provide the real binding IDs. Only add inferred bindings that are missing from the user's config (e.g., user forgot to add KV but code uses `c.env.KV`).

In practice, `@cloudflare/vite-plugin`'s `config` option can be a **function** that receives the resolved wrangler config and returns overrides. This is the right hook:

```typescript
cloudflare({
  config: (resolved) => {
    // In dev: add local bindings for anything inferred but missing
    // In build: trust user's wrangler.json for real IDs
    return mergedConfig;
  },
});
```

**3. CLI changes**

Add a `vite-cloud deploy --target cloudflare` (or just guidance in docs) that runs:

```bash
vite build
# Optionally: wrangler d1 migrations apply DB --local/--remote
wrangler deploy
```

Or simpler: just document that `vite build && wrangler deploy` works if you have a `wrangler.json`.

**4. Migration support**

For raw CF, migrations would use wrangler's built-in D1 migration system rather than the platform's remote runner. Users would:

```bash
# Create migrations in migrations/ directory (already the convention)
wrangler d1 migrations apply DB --remote
wrangler deploy
```

### What Users Would Do

**Minimal `wrangler.json` for a project using D1:**

```json
{
  "name": "my-app",
  "compatibility_date": "2025-12-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ]
}
```

The `main` field and asset config would be handled by `@cloudflare/vite-plugin` (it already sets `main` to `.vite-cloud/entry.ts`).

### What Changes in the Codebase

1. **`packages/vite-cloud/src/index.ts`** — Change how `workerConfig` is built:
   - Check for wrangler config file existence
   - In dev: always add local placeholder bindings (current behavior)
   - In build: only add bindings not already in user's config
   - Pass `configPath` to `cloudflare()` if user has a wrangler config

2. **Docs** — Document the raw CF deployment path:
   - How to create a `wrangler.json`
   - How to create CF resources (`wrangler d1 create`, `wrangler kv namespace create`)
   - How to run migrations (`wrangler d1 migrations apply`)
   - How to deploy (`vite build && wrangler deploy`)

### What Does NOT Change

- The routing plugin, code generation, type generation — all untouched
- The runtime (`defineHandler`, `defineMiddleware`, `convertReturnValue`) — all untouched
- The typed fetch client — works regardless of deployment target
- The vite-cloud platform deploy path — still works as-is for users who want it

## Open Questions

1. **Should we auto-detect `wrangler.json` presence and adjust behavior, or require an explicit option like `viteCloud({ target: "cloudflare" })`?**
   - Auto-detect is more ergonomic but could be surprising
   - Explicit option is clearer but adds config

2. **Should `vcd deploy` still work when a `wrangler.json` exists?**
   - Could warn: "You have a wrangler.json — did you mean `wrangler deploy`?"
   - Or respect it: platform deploy ignores wrangler.json (current behavior via `package.ts` skip)

3. **Static assets** — The `@cloudflare/vite-plugin` already handles Workers Static Assets for direct CF deployment. The dispatch worker's R2-based asset serving is only for the platform. This should "just work" for raw CF.

4. **SSR** — The generated SSR fallback handler should work on raw CF since it's just a standard CF Worker. Need to verify the asset serving path works with Workers Static Assets instead of R2.
