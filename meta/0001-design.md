# Vite Cloud — Design Document

**Date:** 2026-02-15
**Status:** Implemented (living document)

---

## 1. Vision

Vite Cloud is a deployment platform and Vite plugin that makes Cloudflare the easiest place to ship a web app. The user writes a Vite app, adds API routes, uses a database / KV / object storage — and the framework provisions everything automatically. They deploy with one command. No Cloudflare account needed.

**Mental model:** Vite is your framework. Cloudflare is the runtime. Vite Cloud is the invisible bridge.

Progressive experience:

1. `npm create vite-cloud` → scaffold a Vite SPA
2. Add `routes/api/hello.ts` → serverless API endpoint
3. Use `c.env.DB` in that handler → D1 database auto-provisioned
4. `vcd deploy` → live on `*.vitecloud.app`

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      User's Machine                      │
│                                                          │
│   src/                                                   │
│   ├── index.html          (SPA entry)                    │
│   └── App.tsx             (any framework)                │
│                                                          │
│   routes/                                                │
│   ├── api/                                               │
│   │   ├── hello.ts        (GET/POST /api/hello)          │
│   │   └── users/                                         │
│   │       ├── index.ts    (GET/POST /api/users)          │
│   │       └── [id].ts     (GET /api/users/:id)           │
│                                                          │
│   middleware/                                             │
│   └── auth.ts             (runs on every request)        │
│                                                          │
│   vite.config.ts                                         │
│   └── plugins: [viteCloud()]                             │
│                                                          │
└────────────┬────────────────────────────────┬────────────┘
             │ vite dev                       │ vcd deploy
             ▼                                ▼
┌────────────────────────┐     ┌──────────────────────────────┐
│     Local Dev Server    │     │     Vite Cloud Platform       │
│                         │     │                               │
│  Vite Dev Server        │     │  ┌─────────────────────────┐  │
│    ├── Static assets    │     │  │    Control Plane API     │  │
│    └── Proxy /api/* ──────┐  │  │  (auth, projects)        │  │
│                         │  │  │  └──────────┬──────────────┘  │
│  workerd (local)        │◄─┘  │             │                 │
│    ├── API handlers     │     │  ┌──────────▼──────────────┐  │
│    ├── Local D1 (SQLite)│     │  │   Provisioning Engine    │  │
│    ├── Local KV (fs)    │     │  │  (infer bindings, create │  │
│    └── Local R2 (fs)    │     │  │   resources via CF API)  │  │
│                         │     │  └──────────┬──────────────┘  │
└────────────────────────┘     │             │                 │
                                │  ┌──────────▼──────────────┐  │
                                │  │  Workers for Platforms    │  │
                                │  │  (dispatch namespace)     │  │
                                │  └──────────┬──────────────┐  │
                                │             │              │  │
                                │       ┌─────┼─────┐       │  │
                                │       ▼     ▼     ▼       │  │
                                │      D1    KV    R2       │  │
                                │                           │  │
                                └───────────────────────────┘  │
                                └──────────────────────────────┘
```

### Core Components

**Vite Plugin (`vite-cloud`):** User-facing package. `viteCloud()` takes zero arguments — config comes from `vite-cloud.json`. Returns routing plugin + migration plugin + `@cloudflare/vite-plugin`. In framework mode (TanStack Start, React Router), the routing plugin is omitted and the CF plugin hooks into the framework's SSR environment.

**Local Runtime:** `@cloudflare/vite-plugin` runs Worker code in `workerd` via the Vite Environment API. D1 backed by local SQLite, KV and R2 by filesystem. All state in `.vite-cloud/` (gitignored).

**Control Plane (`packages/platform`):** Hono app on CF Workers. Manages users, projects, deploys, usage metering. Uses D1, R2, KV, Workers for Platforms.

**Dispatch Worker (`packages/dispatch`):** Routes `*.vitecloud.app` traffic to user workers and R2 static assets. Handles edge caching, ISR, usage metering via Analytics Engine. Suspension enforcement for usage limit violations.

**Admin Dashboard (`packages/admin`):** Hono JSX server-rendered dashboard for user management, plan changes, suspension controls.

---

## 3. File-Based Routing

Routes live in `routes/` at the project root. HTTP methods are determined by **named exports** (`export const GET`, `export const POST`, etc.) — not filename suffixes.

```
routes/
  api/
    hello.ts              →  GET /api/hello
    users/
      index.ts            →  GET + POST /api/users
      [id].ts             →  GET /api/users/:id
    [org]/[repo]/
      issues.ts           →  /api/:org/:repo/issues
  [...]ts                 →  catch-all fallback
```

Special conventions:

- `[param]` → `:param`, `[...param]` → catch-all, `[...]` → unnamed catch-all
- `(groupname)/` directories → organizational grouping, no URL effect
- `.dev` / `.prod` suffix → environment-specific routes
- Files/dirs starting with `_` are ignored

### Middleware

Defined with `defineMiddleware` in `middleware/` directory. Execute in filename sort order before route handlers.

```ts
// middleware/02.auth.ts
import { defineMiddleware } from "vite-cloud";

export default defineMiddleware(async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return new Response("Unauthorized", { status: 401 });
  await next();
});
```

### Cron Jobs

Files in `jobs/` directory with an exported `cron` string are registered as Cron Triggers:

```ts
// jobs/cleanup.ts
import { defineHandler } from "vite-cloud";
export const cron = "0 * * * *";
export default defineHandler(async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()).run();
});
```

---

## 4. The `defineHandler` API

Thin identity function at runtime. Provides typed Hono `Context` (pre-typed with `CloudEnv`):

```ts
// c.env.DB       — D1Database
// c.env.KV       — KVNamespace
// c.env.STORAGE  — R2Bucket
```

**`defineHandler.withValidator()`** adds Standard Schema validation for `body`, `query`, `params`:

```ts
import * as v from "valibot";
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})(async (c, { body }) => {
  await db.insert("users", { name: body.name, email: body.email });
  return { created: true };
});
```

Return values auto-convert: objects → JSON, strings → text/html, `null` → 204, `Response` → passthrough.

**One DB, one KV, one STORAGE per project by default.** Users wanting raw CF deployment with custom bindings add a `wrangler.json` with real binding IDs — the plugin's `mergeBindings` function respects user-provided config and only adds placeholders for missing inferred bindings.

---

## 5. Typed Route System

Five-part system providing end-to-end type safety:

1. **Route type codegen** — generates `.vite-cloud/routes.d.ts` using `typeof import(...)`. Inlines `Serialize<T>` and `ExtractInput<V>` helper types.
2. **`RouteMap` declaration merging** — `declare module "vite-cloud/routes"` augments the stub interface.
3. **Typed `fetch` client** — `vite-cloud/client` exports `fetch()` constrained by `RouteMap`.
4. **Seamless tsconfig** — `.vite-cloud/tsconfig.json` with `files` entry (inherited by child).
5. **Schema-derived DB types** — DDL parser replays migrations → `.vite-cloud/db.d.ts` augments `vite-cloud/db` with `DbTables`/`DbInsertTables`.

Standard Schema V1 types are inlined — no `@standard-schema/spec` dependency needed.

---

## 6. Binding Inference

**Static analysis only** (runtime JIT inference was considered but not implemented). Uses Vite's `parseSync` (oxc-powered) + `estree-walker` to scan `routes/`, `middleware/`, and `jobs/` for `*.env.DB`, `*.env.KV`, `*.env.STORAGE` member expressions.

Explicit override via `vite-cloud.json`:

```json
{ "bindings": { "db": true, "kv": true } }
```

---

## 7. Relationship to `@cloudflare/vite-plugin`

We build on top of `@cloudflare/vite-plugin`, not replace it. It provides workerd integration, HMR, build output, and Environment API. We add file-based routing, binding inference, auto-provisioning, typed codegen, and managed deployment.

In **default mode**: `viteCloud()` → `[routingPlugin, dbTypesPlugin, migrationPlugin, ...cloudflare({ config: mergeBindings })]`

In **framework mode** (auto-detected via `detectFramework()`): routing plugin is omitted, CF plugin uses `viteEnvironment: { name: "ssr" }` to hook into the framework's environment.

**Raw CF deployment** is supported: if a `wrangler.json` exists, the plugin respects its real binding IDs. Users run `vite build && wrangler deploy`.

---

## 8. Deployment

### CLI Deploy Flow (`vcd deploy`)

1. Build (`vite build`) — client + worker bundles
2. Authenticate — GitHub or Google OAuth, JWT cached locally
3. Upload to Control Plane — manifest, worker script, static assets, migrations
4. Platform provisions D1/KV/R2 resources as needed
5. Platform runs migrations on remote D1 via CF REST API
6. Static assets uploaded to R2, worker deployed to dispatch namespace
7. KV routing entry updated → `{slug}.vitecloud.app` is live

**Key invariant:** Worker never deploys unless all migrations succeed.

### Static Asset Serving

Dispatch worker routes:

- `/api/*` → user Worker (not cached)
- `/*` → R2 static assets with edge caching (`caches.default`)
- Hashed assets: `Cache-Control: public, max-age=31536000, immutable`
- Non-hashed: `Cache-Control: public, s-maxage=60, max-age=0, must-revalidate`
- Non-file paths fall back to `index.html` (SPA routing)

Cache keys include deploy version (`?_v={deploymentId}`) for instant invalidation.

### SSR + ISR

SSR is supported via `src/main.ssr.ts` render entry. ISR (Incremental Static Regeneration) is implemented in the dispatch worker with a two-layer cache (edge + R2).

---

## 9. Platform Architecture

### Authentication

Users sign in via GitHub or Google OAuth. Provider-agnostic user model (`provider`, `provider_id`, `login`, `plan`). JWT tokens, cached at `~/.vite-cloud/config.json`.

### Usage Metering & Tiers

Five tiers: `free`, `solo`, `pro`, `sponsored`, `custom`. Enforcement:

- **Immediate:** deploy count per day (checked at deploy time)
- **Per-request:** CPU time + sub-requests via CF Custom Limits
- **Async:** request count per month via Cron Trigger (queries Analytics Engine, sets `suspended` flag in KV)

### Resource Isolation

All resources live under our CF account. Isolation enforced at the binding level — a user's worker can only access its own D1/KV/R2.

---

## 10. Key Decisions & Resolved Questions

- **No unstorage.** KV and R2 are accessed via native CF APIs (`c.env.KV`, `c.env.STORAGE`). Typed wrappers available at `vite-cloud/kv` and `vite-cloud/storage`.
- **No h3/Nitro.** Hono is the runtime. We take patterns (file-based routing, defineHandler) but not packages.
- **No auto-imports.** Explicit imports for type inference.
- **SSR implemented.** `src/main.ssr.ts` convention + ISR via dispatch worker.
- **Secrets** managed via `vcd secret set NAME=value`.
- **Framework mode** auto-detected — supports TanStack Start and React Router.
- **Auth** supports both platform-level (GitHub/Google OAuth for deployment) and app-level (built-in auth with `vite-cloud/auth` + `c.get("user")` convention).
