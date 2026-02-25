---
outline: deep
---

# What is Void?

Void is a fullstack Vite plugin and deployment platform — in one. The framework understands the platform, and the platform understands the framework. This lets Void offer developer experience that isn't possible when your framework and hosting are separate products.

```sh
npm install -D vite void
```

```ts
import { defineConfig } from "vite";
import voidPlugin from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
```

```sh
void deploy
# app live at <your-subdomain>.void.app!
```

## The idea

With most stacks, the framework builds your app and the platform hosts it. They don't talk to each other. You write config files to bridge the gap — infrastructure declarations, environment variables, resource provisioning, deployment pipelines.

Void removes the gap. Import `db` from `void/db` and a database exists — locally in development and globally replicated in production. Import `kv` or `storage` and the same happens for key-value and object storage. There's nothing to configure because the framework already told the platform what you need.

This is what it unlocks:

- **Write code, not config** — no infrastructure files, no dashboard clicks, no resource declarations. Your imports are your infrastructure.
- **Types from database to frontend** — SQL migrations generate DB types, route handlers infer return types, the [typed fetch client](./typed-fetch.md) checks everything at the call site. One [Standard Schema](https://standardschema.dev/) validator defines runtime validation and compile-time types across the entire stack.
- **Real runtime in development** — `vite dev` runs your server code in the same runtime used in production, with local database, KV, and storage. What works locally works in production.
- **Deploy understands your code** — `void deploy` doesn't just upload files. It reads your migrations, provisions only the resources you use, and deploys to the edge. One command, no intermediate steps.

Under the hood, Void deploys to [Cloudflare Workers](https://developers.cloudflare.com/workers/) — your app runs on Cloudflare's global edge network with D1 (SQLite), Workers KV, R2 object storage, and Workers AI. But you don't need a Cloudflare account or any Cloudflare knowledge to get started.

## How it works

```
vite.config.ts                →  voidPlugin() plugin
routes/api/users.ts           →  API endpoint at /api/users
pages/index.(tsx|vue|svelte)  →  Server-rendered page at /
import { db }                 →  D1 database (auto-provisioned)
import { kv }                 →  KV namespace (auto-provisioned)
import { storage }            →  R2 bucket (auto-provisioned)
import { ai }                 →  Workers AI inference (metered)
migrations/*.sql              →  Applied to D1 on dev startup and deploy
void deploy                   →  Live at https://<slug>.void.app
```

The plugin scans your source code at build time, detects which imports you use, provisions the corresponding Cloudflare bindings on deploy, and routes requests through a generated [Hono](https://hono.dev) app with lazy-loaded handlers for minimal cold starts.

Drop files in `routes/` for API endpoints with method exports, dynamic params, middleware, and validation. Add a `pages/` directory for [server-rendered pages](./pages-routing/overview) with co-located data loading, SPA navigation, and typed forms — works with React, Vue, Svelte, and Solid. Or use any client-side router for a pure SPA.

Void auto-detects your [app type](./app-types) and adapts accordingly. Every build produces a standard Cloudflare Worker, so you can always [self-host](./integrations/cloudflare#deploy-to-your-own-cloudflare-account) with your own `wrangler.json`.

## Next steps

- [Quickstart](./quickstart) — get a running app in minutes
- [Server Routing](./server-routing) — dynamic params, middleware, and validation
- [Pages Routing](./pages-routing/overview) — full-stack pages with server loaders and actions
- [Supported App Types](./app-types) — full-stack, meta-framework, and static site modes
