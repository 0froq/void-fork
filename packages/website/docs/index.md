# What is Vite Cloud?

Vite Cloud is a deployment platform and fullstack Vite plugin that turns any Vite app into a globally distributed, edge-first application on Cloudflare — without requiring a Cloudflare account, config files, or infrastructure knowledge.

Add a single plugin to your `vite.config.ts` and you get file-based API routing with type-safety, a D1 database, KV storage, R2 object storage, and one-command deploys. Just import `db`, `kv`, or `storage` from `vite-cloud` and everything is provisioned automatically based on what your code actually uses.

```sh
npm install -D vite vite-cloud
```

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

```sh
vcc deploy
# app live at <your-subdomain>.vitecloud.app!
```

## Why Vite Cloud?

Cloudflare's primitives are powerful but require significant manual setup: creating `wrangler.json` configs, provisioning D1 databases / KV namespaces / R2 buckets, writing a monolithic `fetch` handler, and managing bindings across environments.

Vite Cloud makes it dead simple:

- **Zero config** — no `wrangler.json`, no dashboard clicks. Write code, deploy.
- **Automatic provisioning** — import `db` from `vite-cloud/db` in a handler and a D1 database is created for you. Same for `kv` and `storage`.
- **File-based routing** — drop a file in `routes/`, get an endpoint. Method suffixes, dynamic params, middleware, catch-alls and [Standard Schema](https://standardschema.dev/) type safety built in.
- **Local dev parity** — `vite dev` runs your handlers in the real `workerd` runtime with local D1 (SQLite), KV, and R2. What works locally works in production.
- **One-command deploy** — `vcc deploy` builds, provisions resources, runs migrations, and deploys. No intermediate steps.

### Flexible by design

Vite Cloud auto-detects your app type — SPA, [SSR](./ssr.md), or [Edge Caching](./edge-caching.md) — and adapts accordingly. Use any UI library, add [Hono](https://hono.dev)-based API routes, or deploy a meta-framework like TanStack Start or React Router v7. Every build produces a standard Cloudflare Worker, so you can always [self-host](./cloudflare.md) with your own `wrangler.json`.

### End-to-end type safety

Types flow from your database to your frontend with zero manual annotations. SQL migrations generate DB types, route handlers infer return types, and the [typed fetch client](./type-safety.md) checks paths, methods, request bodies, and responses at the call site. Add a [Standard Schema](https://standardschema.dev/) validator (zod, valibot, arktype) and one schema defines runtime validation and compile-time types across the entire stack.

## How it works

```
vite.config.ts          →  viteCloud() plugin
routes/api/users.ts     →  API endpoint at /api/users
import { db }           →  D1 database (auto-provisioned)
import { kv }           →  KV namespace (auto-provisioned)
import { storage }      →  R2 bucket (auto-provisioned)
migrations/*.sql        →  Applied to D1 on dev startup and deploy
vcc deploy          →  Live at https://<slug>.vitecloud.app
```

The plugin scans your source code at build time, detects which imports you use (`vite-cloud/db`, `vite-cloud/kv`, `vite-cloud/storage`), provisions the corresponding Cloudflare bindings on deploy, and routes requests through a generated [Hono](https://hono.dev) app with lazy-loaded handlers for minimal cold starts.

## Next steps

- [Quickstart](./quickstart.md) — get a running app in minutes
- [Routing](./routing.md) — dynamic params, middleware, and validation
- [App Types](./app-types.md) — SPA, SSR, SSG, ISR, and meta-framework modes
