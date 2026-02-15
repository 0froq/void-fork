---
name: migrate-vite-cloudflare-to-vite-cloud
description: Migrate an existing Vite app using @cloudflare/vite-plugin to Vite + vite-cloud. Use when a project already runs on Cloudflare Workers but needs Vite Cloud file-based routes, inferred bindings, and vcd deploy workflow.
---

# Migrate Vite + Cloudflare Plugin to Vite Cloud

## When to use

Use this skill when the user has an existing Vite app with `@cloudflare/vite-plugin` and wants to migrate to `vite-cloud` with minimal breakage.

Do not use this for greenfield apps created with `create-vite-cloud`.

## Inputs to gather first

Read these files before editing:

- `package.json`
- `vite.config.*`
- `wrangler.jsonc` (if present)
- Current worker entrypoint (`src/worker.*`, `src/index.*`, etc.)
- Any existing API handlers and migration SQL files

Confirm:

- existing routes/endpoints and HTTP methods
- bindings currently used (`DB`, `KV`, `R2`, etc.)
- whether the app uses framework SSR or only SPA + API

## Migration workflow

1. Update dependencies
- Remove `@cloudflare/vite-plugin` if it is only used for runtime/deploy.
- Add `vite-cloud`.
- Keep existing framework plugins (React/Vue/Svelte/etc.).

2. Update Vite config
- Replace `cloudflare(...)` plugin usage with `viteCloud()`.
- Keep plugin order stable unless there is a known conflict.
- Keep unrelated Vite settings unchanged.

Target shape:

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

3. Migrate API surface to file-based routes
- Create `routes/` if missing.
- Convert each existing endpoint into route files:
  - `routes/api/users.get.ts`
  - `routes/api/users.post.ts`
  - `routes/api/users/[id].get.ts`
- Use `defineHandler` from `vite-cloud`.
- If there is shared logic, move it into regular modules and import from route files.

4. Migrate middleware
- Move request-wide middleware to `middleware/*.ts`.
- Export with `defineMiddleware`.
- Preserve behavior order by filename prefix when needed (`01.auth.ts`, `02.logger.ts`).

5. Preserve bindings with Vite Cloud conventions
- Keep Cloudflare-style uppercase names on `c.env` (`DB`, `KV`, `STORAGE`, etc.).
- Remove manual binding config from Vite plugin config where Vite Cloud now infers usage.
- Ensure route code actually references required bindings so inference can detect them.

6. Migrations
- Place SQL files in `migrations/` (sorted by filename).
- Keep destructive operations gated by explicit pragma if needed.
- If old migrations live elsewhere, copy/rename into this directory with stable ordering.

7. Deploy workflow migration
- Replace old deploy instructions with:
  - `vcd login`
  - `vcd deploy`
- If CI must target a specific project, use:
  - `vcd deploy --project <slug>`
  - or `VITE_CLOUD_PROJECT=<slug> vcd deploy`

## Verification checklist

Run and validate:

1. `npm run dev` (or project dev command)
2. Exercise representative API routes locally.
3. `npm run build`
4. `vcd deploy` and verify live URL responds.

In the Vite Cloud deploy output, verify:

- worker modules uploaded
- static assets uploaded
- migrations applied (if present)

## Common migration pitfalls

- Importing from the main `vite-cloud` runtime in worker route files when a lighter handler import is expected by tooling.
- Forgetting to split method-specific handlers (`GET`/`POST`) into filename suffixes.
- Keeping old custom worker entry wiring that conflicts with generated route runtime.
- Binding names changed to lowercase (`db`) instead of expected uppercase (`DB`), breaking inference/provisioning.

## Deliverable format

When applying this migration, produce:

1. A change summary grouped by config/routes/migrations/CI.
2. A list of moved or newly created route files.
3. Exact commands to run locally and in CI.
