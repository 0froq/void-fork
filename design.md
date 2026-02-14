# Vite Cloud — Design Document

**Version:** 0.2 (Draft)
**Date:** February 2026
**Status:** RFC

---

## 1. Vision

Vite Cloud is a deployment platform and Vite plugin that makes Cloudflare the easiest place to ship a web app. The user writes a Vite app. They add API routes. They use a database, a key-value store, or object storage — and the framework provisions everything automatically. They deploy with one command. They never create a Cloudflare account, never read Cloudflare docs, never touch `wrangler`.

The mental model is: **Vite is your framework. Cloudflare is the runtime. Vite Cloud is the invisible bridge between them.**

The experience is progressive:

1. `npm create vite-cloud` → scaffold a Vite SPA
2. Add `routes/api/hello.ts` → you now have a serverless API endpoint
3. Use `env.db` in that handler → a D1 database is provisioned for you
4. `vite deploy` → your app is live on a `.vitecloud.app` subdomain, globally distributed

No config files. No YAML. No dashboard. Just code.

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
│   │       └── [id].get.ts (GET /api/users/:id)           │
│   └── health.get.ts       (GET /health)                  │
│                                                          │
│   middleware/                                             │
│   └── auth.ts             (runs on every request)        │
│                                                          │
│   vite.config.ts                                         │
│   └── plugins: [viteCloud()]                             │
│                                                          │
└────────────┬────────────────────────────────┬────────────┘
             │ vite dev                       │ vite deploy
             ▼                                ▼
┌────────────────────────┐     ┌──────────────────────────────┐
│     Local Dev Server    │     │     Vite Cloud Platform       │
│                         │     │                               │
│  Vite Dev Server        │     │  ┌─────────────────────────┐  │
│    ├── Static assets    │     │  │    Control Plane API     │  │
│    └── Proxy /api/* ──────┐  │  │  (auth, projects, billing)│  │
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
                                │  │  (dispatch namespace per  │  │
                                │  │   project)                │  │
                                │  └──────────┬──────────────┐  │
                                │             │              │  │
                                │       ┌─────┼─────┐       │  │
                                │       ▼     ▼     ▼       │  │
                                │      D1    KV    R2       │  │
                                │                           │  │
                                └───────────────────────────┘  │
                                └──────────────────────────────┘
```

### Core components:

**Vite Plugin (`vite-plugin-cloud`):** The user-facing package. Installed as a Vite plugin. Handles file-based API routing, binding inference, local dev server orchestration, and the `deploy` command. Built on top of `@cloudflare/vite-plugin` rather than reimplementing the workerd integration from scratch (see Section 6).

**Local Runtime:** Delegates to `@cloudflare/vite-plugin` for running user Worker code inside `workerd` via the Vite Environment API. D1 is backed by a local SQLite file. KV and R2 are backed by the local filesystem. Hot-reloads on file change.

**Control Plane:** A hosted API (itself running on Cloudflare Workers) that manages user accounts, projects, provisioning, deployments, and billing. This is our backend.

**Provisioning Engine:** Receives a deployment manifest (which bindings are needed), diffs against the current project state, and calls the Cloudflare API to create/update D1 databases, KV namespaces, and R2 buckets. Binds them to the user's dispatched worker.

**Build Service (Cloudflare Containers):** When deploys are triggered via GitHub push, our Control Plane spins up an on-demand Container instance to clone the repo, run `npm install` + `vite build`, and upload artifacts. Containers scale to zero when idle — we only pay for active build time.

**Workers for Platforms (Dispatch):** Every user project is a dispatch namespace worker under our platform Cloudflare account. Routing is handled by a dispatch worker that maps `{project}.vitecloud.app` → the correct user worker.

---

## 3. The Vite Plugin

### 3.1 Installation & Setup

```bash
npm create vite-cloud@latest my-app
cd my-app
npm install
npm run dev
```

The scaffolded `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-plugin-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

That's the entire configuration. The plugin does the rest.

### 3.2 File-Based Routing

Mirroring Nitro v3's routing conventions, Vite Cloud uses filesystem routing to automatically map files to routes. Each route file exports a single default handler. The directory structure maps directly to URL paths.

#### Directory Structure

Routes live in `routes/` at the project root. An optional `routes/api/` subdirectory maps to the `/api/` prefix. Unlike Nitro (which primarily targets server routes), Vite Cloud also serves the SPA from `src/` — so the two coexist:

```
src/                        (SPA — client-side app)
  index.html
  App.tsx
routes/                     (Server — Workers handlers)
  api/
    test.ts                 <-- /api/test
  hello.get.ts              <-- /hello (GET only)
  hello.post.ts             <-- /hello (POST only)
vite.config.ts
```

Nested routes via subdirectories:

```
routes/
  api/
    [org]/
      [repo]/
        index.ts            <-- /api/:org/:repo
        issues.ts           <-- /api/:org/:repo/issues
      index.ts              <-- /api/:org
```

#### Static Routes

Create a file in `routes/`. The filename becomes the route path. Export a default handler wrapped in `defineHandler`:

```ts
// routes/api/test.ts
export default defineHandler((ctx) => {
  return { hello: "API" };
});
```

#### Dynamic Routes — Single Param

Use `[<param>]` syntax. The param is available on `ctx.params`:

```ts
// routes/hello/[name].ts
export default defineHandler((ctx) => {
  return `Hello ${ctx.params.name}!`;
});
```

`/hello/nitro` → `Hello nitro!`

#### Dynamic Routes — Multiple Params

Each param is a separate folder. You cannot define multiple params in a single filename.

```ts
// routes/hello/[name]/[age].ts
export default defineHandler((ctx) => {
  return `Hello ${ctx.params.name}! You are ${ctx.params.age} years old.`;
});
```

#### Catch-All Params

Use `[...<param>]` to capture all remaining URL segments (including `/`):

```ts
// routes/hello/[...name].ts
export default defineHandler((ctx) => {
  return `Hello ${ctx.params.name}!`;
});
```

`/hello/nitro/is/hot` → `Hello nitro/is/hot!`

#### Catch-All Route (Default / 404)

A file named `[...].ts` matches all routes not matched by any other handler:

```ts
// routes/[...].ts
export default defineHandler((ctx) => {
  return new Response("Not found", { status: 404 });
});
```

#### Specific HTTP Method

Append the HTTP method to the filename: `hello.get.ts` only matches GET, `users.post.ts` only matches POST.

```ts
// routes/users/[id].get.ts
export default defineHandler(async (ctx) => {
  const user = ctx.env.db.prepare("SELECT * FROM users WHERE id = ?").bind(ctx.params.id).first();
  return Response.json(user);
});
```

```ts
// routes/users.post.ts
export default defineHandler(async (ctx) => {
  const body = await ctx.request.json();
  ctx.env.db.prepare("INSERT INTO users (name) VALUES (?)").bind(body.name).run();
  return { created: true };
});
```

A file without a method suffix (e.g., `hello.ts`) matches all HTTP methods.

#### Route Groups

Wrap a directory name in parentheses to group files for organization without affecting the route path:

```
routes/
  api/
    (admin)/
      users.ts              <-- /api/users
      reports.ts            <-- /api/reports
    (public)/
      index.ts              <-- /api
```

#### Environment-Specific Handlers

Add `.dev` or `.prod` suffix to include a route only in specific builds:

```
routes/
  debug.get.dev.ts          <-- only available in development
  health.get.ts             <-- available in all environments
```

### 3.3 Middleware

Middleware are auto-registered from the `middleware/` directory and run on every request before route handlers. They are defined with `defineHandler` but should not return a value (returning a value short-circuits the request).

```
middleware/
  01.logger.ts              <-- runs first
  02.auth.ts                <-- runs second
routes/
  hello.ts
```

```ts
// middleware/02.auth.ts
export default defineHandler((ctx) => {
  // Returning nothing = request continues to the route handler
  // Returning a value = short-circuits (acts as the response)
  if (!ctx.request.headers.get("Authorization")) {
    return new Response("Unauthorized", { status: 401 });
  }
  ctx.context.user = { name: "Authenticated User" };
});
```

Middleware execute in directory listing order. Prefix filenames with numbers to control ordering (`01.logger.ts`, `02.auth.ts`). Use zero-padded numbers if you have more than 9 middleware.

For route-scoped middleware, use request filtering inside the handler:

```ts
// middleware/admin.ts
export default defineHandler((ctx) => {
  if (ctx.request.url.includes("/api/admin")) {
    // admin-only checks
  }
});
```

### 3.4 The `defineHandler` API

Following Nitro v3's `defineHandler` pattern (and Vite's own `defineConfig` convention), route handlers are wrapped in a `defineHandler` call. This provides full type inference without requiring the user to import and annotate types manually.

`defineHandler` is a thin identity function at runtime — it simply returns the function passed to it. Its value is purely in the type system: it provides the typed `RequestContext` without the user needing to import the type or annotate the parameter. This is auto-imported (no explicit import needed), following the same pattern Nitro uses.

The `RequestContext` shape:

```ts
interface RequestContext {
  request: Request; // standard Web Request
  params: Record<string, string>; // route params from [id] etc.
  context: Record<string, any>; // mutable context (set by middleware)
  env: {
    db: D1Database; // auto-provisioned D1 instance
    kv: KVNamespace; // auto-provisioned KV namespace
    storage: R2Bucket; // auto-provisioned R2 bucket
  };
}
```

**Why `defineHandler` over raw function exports?** Three reasons: (1) type inference without imports, (2) it gives us a compile-time marker for transforms and tree-shaking, and (3) it opens the door for future options like `defineHandler({ cache: 60 }, (ctx) => ...)` without breaking the API.

**Return values** are automatically converted to responses, matching Nitro's behavior: objects/arrays are serialized as JSON with `application/json` content type, strings are sent as `text/html`, `null` produces a `204 No Content`, and `Response` objects are passed through as-is.

The key design decision: **there is exactly one `db`, one `kv`, and one `storage` per project by default.** This removes the "which namespace?" question entirely. Power users who need multiple databases can configure them explicitly (see Section 9), but the default is one of each, automatically provisioned the moment you reference it.

### 3.5 Code Splitting

Following Nitro's approach, each route handler is compiled into a separate chunk. Chunks are loaded on-demand when a route is first requested — `/api/users` doesn't load code for `/api/posts`. This keeps cold-start times minimal on Workers.

### 3.6 Route Rules

For common cross-cutting concerns (caching, CORS, redirects, proxying), route rules can be declared in config without writing handler code:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    viteCloud({
      routeRules: {
        "/api/blog/**": { cache: { maxAge: 3600 } },
        "/api/v1/**": { cors: true },
        "/old-api/**": { redirect: "/api/v2/**" },
      },
    }),
  ],
});
```

---

## 4. Leveraging the unjs Ecosystem

Rather than building all abstractions from scratch, Vite Cloud should strategically adopt from the unjs ecosystem where it adds value without creating coupling.

### 4.1 unstorage for KV and R2

`unstorage` provides a unified key-value storage interface with drivers for Cloudflare KV (`cloudflare-kv-binding`), R2 (`cloudflare-r2-binding`), and filesystem (for local dev). This is a natural fit:

```ts
// What the user writes:
export const GET = defineHandler(async (ctx) => {
  await ctx.env.kv.set("session:abc", JSON.stringify({ userId: 1 }));
  const session = await ctx.env.kv.get("session:abc");
  return Response.json(session);
});
```

Under the hood, `ctx.env.kv` is an `unstorage` instance configured with the appropriate driver:

- **Local dev:** `fs` driver pointing to `.vite-cloud/kv/`
- **Production:** `cloudflare-kv-binding` driver wired to the provisioned KV namespace

Benefits: the user gets a consistent API across environments, and we inherit unstorage's ecosystem (TTL support, typed getters, prefix scoping) without building it ourselves.

**However, `ctx.env.db` (D1) should remain the raw D1 API.** unstorage doesn't have a D1 driver and key-value semantics don't map to SQL. D1's `prepare().bind().all()` API is already clean and well-documented.

**And `ctx.env.storage` (R2) is a design decision.** We can either expose R2's native API (richer: multipart uploads, HTTP metadata, conditional gets) or wrap it with unstorage (simpler but lossy). Recommendation: expose the native R2 API by default, but provide `ctx.env.kv` as the unstorage-backed simple key-value abstraction for users who don't need R2's full power. This means:

| Binding           | API           | Backed by          |
| ----------------- | ------------- | ------------------ |
| `ctx.env.db`      | D1 native API | D1 (local: SQLite) |
| `ctx.env.kv`      | unstorage     | KV (local: fs)     |
| `ctx.env.storage` | R2 native API | R2 (local: fs)     |

### 4.2 What Not to Adopt from unjs

We should **not** adopt Nitro as a dependency or build on h3. Here's why:

- **Nitro is a server framework.** Vite Cloud is a Vite plugin that compiles to Cloudflare Workers. Nitro's value is its cross-platform runtime abstraction (Node, Deno, Bun, Workers, etc.) — but we don't need that. We target exactly one runtime.
- **h3 adds an abstraction layer over Request/Response.** The Workers runtime already has excellent native Web API support. Adding h3 means teaching users two APIs (`event` vs `Request`) and adding a compatibility layer.
- **We take the patterns, not the packages.** `defineHandler` (from `defineEventHandler`), file-based routing, auto-imports, middleware conventions — these are great ideas we adopt. But we implement them directly against the Workers runtime API.

The exception is `unstorage`, which is a genuine thin adapter with no runtime overhead and real value in its driver system.

---

## 5. Binding Inference

### 5.1 Static Analysis with oxc

Vite 7+ ships with oxc-powered `parseSync` / `parse` APIs. Since we're already building a Vite plugin, we should use the parser that ships with Vite itself rather than adding a separate dependency. The inference scans all files in `routes/`:

```ts
import { parseSync } from "vite";

function inferBindings(code: string, filename: string): BindingManifest {
  const { program } = parseSync(filename, code);

  const bindings = { needsD1: false, needsKV: false, needsR2: false };

  // Walk the ESTree-compatible AST looking for:
  // - ctx.env.db    → needsD1
  // - ctx.env.kv    → needsKV
  // - ctx.env.storage → needsR2
  walk(program, {
    MemberExpression(node) {
      if (isCtxEnvAccess(node, "db")) bindings.needsD1 = true;
      if (isCtxEnvAccess(node, "kv")) bindings.needsKV = true;
      if (isCtxEnvAccess(node, "storage")) bindings.needsR2 = true;
    },
  });

  return bindings;
}
```

oxc's parser is significantly faster than acorn or babel (native Rust via NAPI bindings), produces ESTree-compatible AST, and handles TypeScript natively — no separate transform step needed.

### 5.2 Runtime Just-In-Time Inference

Static analysis has known blind spots: dynamic property access, bindings passed through helper functions, or code generated at runtime. An alternative (or complement) is **runtime JIT inference**:

**How it would work:** In the local dev environment, `ctx.env` is a Proxy object. When the user's handler accesses `ctx.env.db`, the proxy traps the property access, records it, and returns the appropriate local-backed binding. At deploy time, the recorded accesses become the manifest.

```ts
// Inside the local dev runtime:
function createEnvProxy(localBindings: LocalBindings): Env {
  const accessed = new Set<string>();

  return new Proxy({} as Env, {
    get(target, prop: string) {
      accessed.add(prop);
      return localBindings[prop];
    },
  });
}
```

**Tradeoffs:**

| Approach        | Pros                                                       | Cons                                                                                      |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Static (oxc)    | Deterministic, works without running code, fast CI deploys | Misses dynamic patterns                                                                   |
| Runtime (Proxy) | Catches everything actually used, zero false negatives     | Requires the code to run (needs test coverage), can't infer from code paths not exercised |

**Recommendation: use both.** Static analysis is the primary inference mechanism (runs at build/deploy time). Runtime inference runs during `vite dev` and writes a `.vite-cloud/inferred-bindings.json` file. At deploy time, the manifest is the union of static analysis + last-known runtime inference. This gives maximum coverage while remaining deterministic for CI deploys.

### 5.3 Explicit Override

The user can always declare bindings explicitly, which takes precedence over any inference:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    viteCloud({
      bindings: { db: true, kv: true }, // override inference
    }),
  ],
});
```

---

## 6. Relationship to `@cloudflare/vite-plugin`

`@cloudflare/vite-plugin` (GA as of April 2025) already provides deep Vite integration with the Workers runtime using the Vite Environment API. It runs Worker code inside `workerd` during development, supports HMR, handles `vite build` for both client and worker output, and supports `vite preview` in the Workers runtime.

**We should build on top of it, not replace it.**

### 6.1 What `@cloudflare/vite-plugin` Does Well

- Runs user code in `workerd` (real Workers runtime) during development, not Node.js
- Uses Vite's Environment API for proper module graph isolation between client and worker
- Handles build output that `wrangler deploy` can consume directly
- Supports bindings declared in `wrangler.jsonc`
- HMR for both client and worker code
- Framework support (React Router v7, TanStack Start)

### 6.2 What It Doesn't Do (Our Value-Add)

| Capability                              | `@cloudflare/vite-plugin`           | Vite Cloud           |
| --------------------------------------- | ----------------------------------- | -------------------- |
| File-based API routing                  | No (raw Worker `fetch` handler)     | Yes (Nitro v3-style) |
| `defineHandler` with typed context      | No                                  | Yes                  |
| Auto-provisioning of D1/KV/R2           | No (user creates via wrangler)      | Yes                  |
| Binding inference                       | No (declared in wrangler.jsonc)     | Yes                  |
| Managed deployment platform             | No (user deploys to own CF account) | Yes                  |
| Zero-config                             | Near-zero (needs wrangler.jsonc)    | True zero-config     |
| Managed hosting & billing               | No                                  | Yes                  |
| GitHub integration with preview deploys | No (separate CF Builds setup)       | Yes                  |

### 6.3 Implementation Strategy

Vite Cloud's plugin wraps `@cloudflare/vite-plugin`:

```ts
// Simplified internal architecture
import { cloudflare } from "@cloudflare/vite-plugin";

export default function viteCloud(options?: ViteCloudOptions): Plugin[] {
  return [
    // Our plugin: file-based routing, defineHandler transform, inference
    viteCloudRoutingPlugin(options),
    viteCloudInferencePlugin(options),
    viteCloudDeployPlugin(options),

    // Cloudflare's plugin: workerd runtime, Environment API, build
    cloudflare({
      config: (baseConfig) => ({
        ...baseConfig,
        // We programmatically inject bindings discovered by inference
        d1_databases: inferredManifest.needsD1
          ? [{ binding: "DB", database_name: "default", database_id: "local" }]
          : [],
        kv_namespaces: inferredManifest.needsKV ? [{ binding: "KV", id: "local" }] : [],
        r2_buckets: inferredManifest.needsR2
          ? [{ binding: "STORAGE", bucket_name: "default" }]
          : [],
      }),
    }),
  ];
}
```

This means:

- **We don't reimplement workerd integration.** Cloudflare maintains this, and it tracks the real runtime perfectly.
- **We don't need a wrangler.jsonc file.** We use `@cloudflare/vite-plugin`'s programmatic `config` option to inject bindings discovered by inference.
- **We get HMR, `vite preview`, and runtime fidelity for free.**
- **Our deploy command bypasses `wrangler deploy`** and instead uploads to our own platform control plane, which uses Workers for Platforms.

### 6.4 Risk: Upstream Dependency

Building on `@cloudflare/vite-plugin` creates a dependency on Cloudflare's maintenance of it. However: (a) it's GA and actively developed, (b) Cloudflare is deeply invested in the Vite ecosystem, (c) the alternative (reimplementing workerd integration) is months of work with worse fidelity, (d) if needed, we can fork — it's open source.

---

## 7. Local Development

### 7.1 How It Works

Running `npm run dev` (which calls `vite dev`) starts Vite's dev server with the Cloudflare Vite plugin creating a `workerd`-backed environment. Our plugin layers on top:

1. **Vite's dev server** — serves the SPA with HMR as normal.
2. **`workerd` via `@cloudflare/vite-plugin`** — runs API handlers in the real Workers runtime.
3. **Our routing layer** — transforms file-based routes from `routes/` into a single Worker `fetch` handler with routing logic, compiles `defineHandler` calls, registers middleware, and configures bindings.

The Vite dev server proxies all `/api/*` requests to the `workerd` environment. From the user's perspective, `http://localhost:5173/api/hello` just works.

### 7.2 Local Storage Backends

| Binding       | Local Implementation                          | Location                  |
| ------------- | --------------------------------------------- | ------------------------- |
| `env.db`      | SQLite via `workerd`'s built-in D1 local mode | `.vite-cloud/d1/local.db` |
| `env.kv`      | unstorage `fs` driver                         | `.vite-cloud/kv/`         |
| `env.storage` | Miniflare's local R2 emulation                | `.vite-cloud/r2/`         |

All local data lives in `.vite-cloud/` (gitignored by default). The user can inspect the SQLite database directly with any SQLite client — useful for debugging.

### 7.3 Hot Reload

When an API handler file changes:

1. `@cloudflare/vite-plugin` detects the change via Vite's module graph
2. Our plugin re-compiles the routing layer
3. The `workerd` environment receives the update via Vite's HMR
4. Next request hits the updated code — no full restart needed

This is significantly better than the approach in v0.1 of the doc (restarting workerd on each change). The Cloudflare Vite plugin's Environment API integration means worker code gets true HMR.

### 7.4 Database Migrations

For v1, we take a simple approach: the user writes migrations as SQL files.

```
migrations/
  001_create_users.sql
  002_add_email_column.sql
```

On `vite dev`, the plugin applies any unapplied migrations to the local SQLite database automatically. On `vite deploy`, it applies them to the remote D1 database before deploying the new worker. A `_migrations` table tracks what has been applied.

---

## 8. Deployment

### 8.1 CLI Deploy Flow

```
vite deploy
    │
    ├── 1. Build (vite build)
    │   ├── Bundle SPA assets (client build)
    │   └── Bundle API handlers into Worker script (worker build via CF plugin)
    │
    ├── 2. Authenticate
    │   └── OAuth login to Vite Cloud (first time only, token cached)
    │
    ├── 3. Infer Bindings
    │   ├── Static analysis via oxc parseSync
    │   └── Merge with .vite-cloud/inferred-bindings.json (runtime inference)
    │
    ├── 4. Upload to Control Plane
    │   ├── Manifest (bindings + migrations)
    │   ├── Worker script bundle
    │   └── Static assets (hashed)
    │
    ├── 5. Control Plane: Provision
    │   ├── Diff manifest against current project state
    │   ├── Create new D1/KV/R2 resources if needed (Cloudflare API)
    │   └── Apply pending migrations to D1
    │
    ├── 6. Control Plane: Deploy
    │   ├── Upload static assets to R2 (platform-owned, for serving)
    │   ├── Upload Worker script to dispatch namespace
    │   └── Bind provisioned resources to the worker
    │
    └── 7. Done
        └── https://my-app.vitecloud.app is live
```

### 8.2 GitHub Integration

Beyond CLI deploys, Vite Cloud supports a Git-based deploy workflow similar to Vercel's:

**Setup:**

```bash
npx vite-cloud link --github   # connects project to a GitHub repo
```

Or via the Vite Cloud dashboard: import a GitHub repo, and we handle the rest.

**How it works:**

1. User installs the "Vite Cloud" GitHub App on their repo (OAuth flow, scoped to selected repos).
2. On each push to the configured branch (default: `main`), our GitHub App receives a webhook.
3. Our build service (running on Cloudflare Workers + possibly a build worker):
   - Clones the repo (shallow, specific commit)
   - Runs `npm install` + `vite build`
   - Performs binding inference on the built output
   - Uploads to the control plane → provision → deploy
4. The deployment status is reported back to GitHub as a commit status / check run.
5. For pull requests: we deploy a **preview instance** at `{pr-number}--{project}.vitecloud.app` and post a comment with the preview URL.

**Preview Deployments:**

Each PR gets its own isolated deployment. Preview deployments share the project's D1/KV/R2 resources by default (read-only for safety), or can be configured to use a separate "preview" D1 database seeded from production.

| Trigger                 | Target     | URL                                 |
| ----------------------- | ---------- | ----------------------------------- |
| Push to `main`          | Production | `{project}.vitecloud.app`           |
| Push to PR branch       | Preview    | `{pr-num}--{project}.vitecloud.app` |
| `vite deploy` from CLI  | Production | `{project}.vitecloud.app`           |
| `vite deploy --preview` | Preview    | `preview--{project}.vitecloud.app`  |

**Build Infrastructure — Cloudflare Containers:**

Cloudflare Containers (public beta, June 2025) are the ideal build environment. They run on-demand, scale to zero, deploy globally, and are deeply integrated with Workers — which means our entire platform stays on Cloudflare. No need for external VM fleets on Fly.io or AWS.

How it works:

1. When a deploy is triggered (CLI push or GitHub webhook), our Control Plane Worker enqueues a build job.
2. The Worker spins up a Container instance via `env.BUILD_RUNNER.get(buildId)`. Each build gets its own isolated container.
3. The container runs a Node.js image with our build script: `git clone` → `npm install` → `vite build` → upload artifacts to our Control Plane API.
4. After the build completes, the container goes to sleep. We only pay for active build time (billed per 10ms).

Container config for the build runner:

```jsonc
// wrangler.jsonc (our platform's build service)
{
  "containers": [
    {
      "class_name": "BuildRunner",
      "image": "./build-runner", // Node.js image with git, npm, vite
      "instance_type": "basic", // 1 GiB RAM, 1/4 vCPU, 4GB disk
      "max_instances": 50,
    },
  ],
}
```

The `basic` instance type (1 GiB RAM, 4GB disk) is sufficient for most Vite builds. For projects with very large `node_modules`, we can offer a `standard-1` (4 GiB RAM, 8GB disk) for Pro users.

**Why this is better than external VMs:**

- **Same platform** — the entire Vite Cloud stack (dispatch worker, control plane, build service, containers) runs on Cloudflare. One account, one billing relationship, one operational surface.
- **Scale to zero** — we don't pay for idle build capacity. Free-tier builds that happen once a day cost almost nothing.
- **Global** — containers boot near the user, so `git clone` from GitHub is fast regardless of the user's region.
- **No ops** — no Kubernetes, no Terraform, no fleet management. Just `wrangler deploy` for our build service.

**Cost estimate:** A typical Vite build takes 30–60 seconds on a `basic` instance. At Cloudflare's pricing ($0.000020/vCPU-sec + $0.0000025/GiB-sec memory), a 60-second build costs roughly $0.003. Even at 10,000 builds/month, build infrastructure costs ~$30/month. This is dramatically cheaper than maintaining a VM fleet.

**Caching strategy:** To keep builds fast, the build container should cache `node_modules`. Options: (a) mount an R2 bucket via FUSE (Cloudflare Containers support this) to persist a shared cache of common npm packages, or (b) upload a tarball of `node_modules` keyed by lockfile hash to R2 after each build, download it at the start of subsequent builds. Option (b) is simpler and avoids FUSE complexity.

### 8.3 Static Asset Serving

Static assets (JS, CSS, images) are uploaded to a platform-owned R2 bucket and served via a Cloudflare Worker with Cache API. This is separate from the user's R2 bucket (which is for their application data). Asset URLs are content-hashed for immutable caching.

The dispatch worker routes:

- `/api/*` → user's Worker (API handlers)
- `/*` → static assets from R2 (SPA with fallback to `index.html`)

### 8.4 Custom Domains

Users can add custom domains via the CLI:

```bash
npx vite-cloud domains add myapp.com
```

Under the hood, this creates a Custom Hostname on our platform's Cloudflare zone using the Custom Hostnames API (formerly SSL for SaaS). The user points their DNS to our CNAME. SSL is automatic.

---

## 9. Platform Architecture (Our Backend)

### 9.1 Workers for Platforms Setup

Our Cloudflare account structure:

- **Dispatch Worker:** Routes incoming requests based on hostname → correct user worker. Runs on `*.vitecloud.app` and any custom domains.
- **Dispatch Namespace:** Each user project gets a worker in the namespace. Named by `{user_id}_{project_slug}`.
- **Shared Resources:** Each project gets its own isolated D1 database, KV namespace, and R2 bucket — all under our account but logically separated.

### 9.2 Control Plane API

A Cloudflare Worker (or set of Workers) that handles:

| Endpoint                     | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `POST /auth/login`           | GitHub OAuth → JWT                        |
| `POST /projects`             | Create a new project                      |
| `POST /projects/:id/deploy`  | Accept build artifacts, provision, deploy |
| `GET /projects/:id/status`   | Deployment status, resource usage         |
| `POST /projects/:id/domains` | Add custom domain                         |
| `POST /webhooks/github`      | Receive push/PR events from GitHub App    |

Data stored in a platform D1 database: users, projects, deployments, resource mappings, GitHub app installations.

### 9.3 Resource Isolation

Even though all resources live under our single Cloudflare account, isolation is enforced at the binding level: a user's worker can only access its own D1/KV/R2 because those are the only bindings attached to it. There is no way for User A's worker to reference User B's database. This is the same isolation model Workers for Platforms is designed for.

### 9.4 Provisioning Engine Detail

The provisioning engine is the most critical internal component. On each deploy:

1. **Receive manifest** from the CLI or build service (bindings needed + migration files)
2. **Load project state** from our platform DB (which resources already exist)
3. **Diff:**
   - If manifest says `needsD1: true` and no D1 exists → create one via `POST /accounts/{account_id}/d1/database`
   - If D1 exists and there are new migrations → apply them via D1 API
   - Same logic for KV and R2
4. **Deploy worker** to dispatch namespace with correct bindings
5. **Update project state** in platform DB

Resource deletion is intentionally manual (via CLI or future dashboard). We never auto-delete a database just because the user removed `ctx.env.db` from their code — that would be catastrophic.

---

## 10. Authentication & Accounts

### 10.1 User Auth

Users sign in via GitHub OAuth (expandable to other providers later). First deploy triggers the OAuth flow in the browser. A token is cached locally at `~/.vite-cloud/credentials.json`.

No Cloudflare account needed. The user's identity is managed entirely by us.

### 10.2 Project Identity

Each project is identified by a `project.json` file in the repo root (auto-created on first deploy):

```json
{
  "projectId": "proj_a1b2c3d4",
  "name": "my-app"
}
```

This file should be committed. It's how the CLI knows which remote project to deploy to.

---

## 11. Progressive Complexity (Escape Hatches)

The framework should feel zero-config for simple cases but not trap advanced users. Escape hatches, in order of complexity:

### 11.1 Multiple Bindings

```ts
// vite.config.ts
viteCloud({
  d1: {
    db: true, // default database
    analytics: true, // second database, accessed as ctx.env.analytics
  },
});
```

### 11.2 Scheduled Handlers (Cron)

```ts
// src/api/_scheduled.ts
export default defineScheduled((ctx) => {
  ctx.env.db.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()).run();
});

export const cron = "0 * * * *"; // every hour
```

### 11.3 Raw Worker Access

For users who outgrow the file-based routing:

```ts
// vite.config.ts
viteCloud({
  worker: "./src/worker.ts", // bypass file-based routing entirely
});
```

This gives the user a raw Worker `fetch` handler with all bindings still auto-provisioned.

---

## 12. Pricing Model

### Free Tier

- 1 project
- D1: 500MB storage, 5M reads/day, 100K writes/day
- KV: 1GB storage, 100K reads/day, 1K writes/day
- R2: 1GB storage, 10M reads/month, 1M writes/month
- Workers: 100K requests/day
- `*.vitecloud.app` subdomain only

### Pro ($20/month)

- Unlimited projects
- D1: 10GB storage, uncapped reads, 10M writes/day
- KV: 10GB storage, uncapped reads, 100K writes/day
- R2: 50GB storage, uncapped reads/writes
- Workers: 10M requests/month
- Custom domains
- Preview deployments per branch
- GitHub integration

### Team ($50/month base + $15/seat)

- Everything in Pro
- Collaboration (multiple deployers per project)
- Staging environments
- Audit logs

The pricing should be structured so our margins work within Cloudflare's Enterprise pricing. The key insight: Cloudflare's per-request costs at enterprise scale are very low, so even generous free tiers are affordable if we control abuse.

---

## 13. Technical Risks & Open Questions

### Risk: `@cloudflare/vite-plugin` API Stability

We build on `@cloudflare/vite-plugin`'s programmatic `config` option and internal behavior. If Cloudflare changes the API surface, we break.

**Mitigation:** The plugin is GA (v1.0+) and the `config` option is a documented, public API. Pin versions. Engage with the Cloudflare team — since Vite Cloud drives adoption of Workers, there's aligned incentive.

### Risk: Static Analysis Accuracy

Even with oxc + runtime JIT, some patterns will escape inference. A user could pass `ctx.env` to a library function that conditionally uses `db`.

**Mitigation:** The dual inference strategy (static + runtime) covers the vast majority of cases. The explicit `bindings` config is always available. We can add a deploy-time warning: "We detected you use `ctx.env.db` but no D1 binding was provisioned. Add `bindings: { db: true }` to your config."

### Risk: D1 Migration Failures on Deploy

Migrations applied to remote D1 during deploy could fail (bad SQL, schema conflicts). This would leave the deploy in a broken state.

**Mitigation:** Run migrations in a transaction. If they fail, abort the deploy entirely and report the error. Don't update the worker until migrations succeed. Provide a `vite-cloud db rollback` command. Add a `vite deploy --dry-run` that validates migrations against the remote schema.

### Risk: Workers for Platforms Limits

Dispatch namespaces may have limits on the number of workers, script size, or bindings per worker. These are enterprise-negotiated.

**Mitigation:** Negotiate limits upfront with Cloudflare. Architect for sharding across multiple dispatch namespaces if needed.

### Risk: Build Infrastructure Reliability

Cloudflare Containers are in public beta. Build reliability depends on container boot times, image caching, and the stability of the Containers platform.

**Mitigation:** Pin to stable container instance types. Implement build retries with exponential backoff. Keep a fallback path: if container builds fail, the user can always build locally and push via `vite deploy` (which uploads pre-built artifacts). Monitor container boot latency and build success rates. As Containers matures toward GA, reliability should improve. For the critical path (production deploys), consider offering a "build locally, deploy remotely" mode as the default for free tier.

### Open Question: SSR

Server-side rendering is not in scope for v1 (this is SPA + API routes). But `@cloudflare/vite-plugin` already supports SSR with React Router v7 and TanStack Start. When we're ready, we can extend our routing layer to support SSR by integrating with these frameworks' Cloudflare adapters.

### Open Question: Durable Objects

Durable Objects are powerful but hard to abstract (unique addressing, single-instance guarantees, WebSocket hibernation). They don't fit the "auto-provision one per project" model. Likely should remain an explicit opt-in with dedicated docs.

### Open Question: Environment Variables & Secrets

The current design doesn't address secrets (API keys, tokens). Likely solution: `vite-cloud env set STRIPE_KEY=sk_live_...` which stores it encrypted and binds it as a Worker secret. Available as `ctx.env.STRIPE_KEY`. Local dev reads from a `.env` file (auto-loaded by Vite).

---

## 14. Implementation Phases

### Phase 1: Local Dev (Weeks 1–4)

- [ ] `create-vite-cloud` scaffolding CLI
- [ ] Vite plugin wrapping `@cloudflare/vite-plugin`
- [ ] `defineHandler` with auto-imports and type inference
- [ ] File-based routing from `routes/` (compiles to Worker `fetch` handler)
- [ ] HTTP method routing via filename suffix (`.get.ts`, `.post.ts`)
- [ ] Dynamic params, catch-all, and route groups
- [ ] Middleware from `middleware/` directory with ordering
- [ ] Binding inference via oxc `parseSync` (imported from `vite`)
- [ ] Local runtime with D1/KV/R2 (via CF plugin's local bindings)
- [ ] Hot reload for API handlers (via Environment API HMR)
- [ ] Local migration runner

**Milestone:** A user can run `npm create vite-cloud`, add a route file in `routes/api/` using `defineHandler` that queries a database, and see it work locally with zero config.

### Phase 2: Platform & Deploy (Weeks 5–10)

- [ ] Control Plane API (auth, projects, deploy)
- [ ] Provisioning engine (D1, KV, R2 creation via CF API)
- [ ] Dispatch worker + routing
- [ ] Static asset serving via R2
- [ ] `vite deploy` command in the plugin
- [ ] Remote migration execution
- [ ] `*.vitecloud.app` subdomain routing
- [ ] Runtime JIT inference (Proxy-based) + manifest merging

**Milestone:** A user can deploy their app to a live URL with one command.

### Phase 3: GitHub & Production Readiness (Weeks 11–16)

- [ ] GitHub App for webhook-based deploys
- [ ] Build infrastructure (container fleet + job queue)
- [ ] Preview deployments per PR
- [ ] Custom domains
- [ ] Secrets management
- [ ] Usage metering and limits enforcement
- [ ] Billing integration (Stripe)
- [ ] Dashboard (web UI for managing projects, viewing logs)
- [ ] Rate limiting and abuse protection on free tier

**Milestone:** Ready for public beta.

### Phase 4: Growth (Post-Launch)

- [ ] SSR support (leverage CF plugin's existing SSR capabilities)
- [ ] Durable Objects (explicit opt-in)
- [ ] Queues & Cron triggers
- [ ] Analytics (built-in request analytics)
- [ ] Team collaboration features
- [ ] `vite-cloud` standalone CLI (for resource management)

---

## 15. Competitive Landscape

| Feature            | Vite Cloud         | Vercel          | Cloudflare Pages         | NuxtHub                  |
| ------------------ | ------------------ | --------------- | ------------------------ | ------------------------ |
| Runtime            | Cloudflare Workers | AWS Lambda@Edge | Cloudflare Workers       | Cloudflare Workers       |
| Framework required | No (any Vite app)  | Next.js-centric | No                       | Nuxt only                |
| Managed DB         | Yes (D1, auto)     | Vercel Postgres | No (manual)              | Yes (D1 via hubDatabase) |
| Auto-provisioning  | Yes                | Partial         | No                       | Yes (Nuxt-scoped)        |
| Edge-first         | Yes                | Partial         | Yes                      | Yes                      |
| Zero config        | Yes                | Near-zero       | No (needs wrangler.json) | Near-zero (Nuxt)         |
| GitHub deploys     | Yes                | Yes             | Yes                      | Yes                      |
| CF account needed  | No                 | N/A             | Yes                      | Yes                      |

Our positioning: **framework-agnostic NuxtHub**. NuxtHub proves the "auto-provision Cloudflare primitives" model works, but only for Nuxt. Vite Cloud brings the same experience to every Vite-based app — React, Vue, Svelte, Solid, or plain HTML.

---

## 16. Success Criteria

**Phase 1 (Local Dev):**

- A new user goes from `npm create` to a working local app with database in under 2 minutes
- Zero configuration files beyond `vite.config.ts`

**Phase 2 (Deploy):**

- First deploy completes in under 60 seconds
- Subsequent deploys (no new resources) complete in under 15 seconds

**Phase 3 (GitHub):**

- Push-to-deploy works within 90 seconds of push
- Preview URLs posted to PRs within 2 minutes

**Public Beta:**

- 1,000 deployed projects within first 3 months
- NPS > 50 on developer experience
- Platform uptime > 99.9%

---

## Appendix A: Example Project Structure

```
my-app/
├── src/
│   ├── index.html
│   ├── main.ts
│   ├── App.vue              (or .tsx, .svelte, etc.)
│   └── components/
│       └── Header.vue
├── routes/
│   ├── api/
│   │   ├── health.get.ts    (GET /api/health)
│   │   ├── users/
│   │   │   ├── index.get.ts (GET /api/users)
│   │   │   ├── index.post.ts(POST /api/users)
│   │   │   └── [id].get.ts  (GET /api/users/:id)
│   │   └── upload.post.ts   (POST /api/upload — uses R2)
│   └── [...].ts              (catch-all fallback)
├── middleware/
│   ├── 01.logger.ts
│   └── 02.auth.ts
├── migrations/
│   ├── 001_create_users.sql
│   └── 002_add_posts.sql
├── public/
│   └── favicon.ico
├── project.json              (auto-generated on first deploy)
├── vite.config.ts
├── package.json
└── .vite-cloud/              (gitignored, local dev data)
    ├── d1/local.db
    ├── kv/
    ├── r2/
    └── inferred-bindings.json
```

## Appendix B: API Handler Examples

**Simple JSON endpoint:**

```ts
// routes/api/health.get.ts
export default defineHandler(() => {
  return { status: "ok", timestamp: Date.now() };
});
```

**Database CRUD:**

```ts
// routes/api/users/[id].get.ts
export default defineHandler((ctx) => {
  const user = ctx.env.db.prepare("SELECT * FROM users WHERE id = ?").bind(ctx.params.id).first();

  if (!user) return new Response("Not found", { status: 404 });
  return user; // auto-serialized as JSON
});
```

```ts
// routes/api/users/[id].delete.ts
export default defineHandler((ctx) => {
  ctx.env.db.prepare("DELETE FROM users WHERE id = ?").bind(ctx.params.id).run();

  return null; // 204 No Content
});
```

**File upload to R2:**

```ts
// routes/api/upload.post.ts
export default defineHandler(async (ctx) => {
  const formData = await ctx.request.formData();
  const file = formData.get("file") as File;

  const key = `uploads/${Date.now()}-${file.name}`;
  await ctx.env.storage.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  return { key, url: `/api/files/${key}` };
});
```

**KV via unstorage:**

```ts
// routes/api/session.get.ts
export default defineHandler(async (ctx) => {
  const sessionId = ctx.request.headers.get("X-Session-Id");
  const data = await ctx.env.kv.get(`session:${sessionId}`);
  return data ?? { authenticated: false };
});
```

```ts
// routes/api/session.post.ts
export default defineHandler(async (ctx) => {
  const body = await ctx.request.json();
  const sessionId = crypto.randomUUID();
  await ctx.env.kv.set(`session:${sessionId}`, JSON.stringify(body), { ttl: 3600 });
  return { sessionId };
});
```

**Middleware with auth:**

```ts
// middleware/02.auth.ts
export default defineHandler((ctx) => {
  // Skip auth for public routes
  if (!new URL(ctx.request.url).pathname.startsWith("/api/admin")) return;

  const token = ctx.request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }
  ctx.context.user = { token };
});
```

**Environment-specific debug route:**

```ts
// routes/api/debug.get.dev.ts — only exists in development
export default defineHandler((ctx) => {
  return {
    bindings: Object.keys(ctx.env),
    params: ctx.params,
    headers: Object.fromEntries(ctx.request.headers),
  };
});
```
