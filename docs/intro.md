# What is Vite Cloud?

Vite Cloud is a deployment platform and fullstack Vite plugin that turns any Vite app into a globally distributed, edge-first application on Cloudflare — without requiring a Cloudflare account, config files, or infrastructure knowledge.

Add a single plugin to your `vite.config.ts` and you get file-based API routing, a D1 database, KV storage, R2 object storage, and one-command deploys. Vite Cloud provisions everything automatically based on what your code actually uses.

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

## Why Vite Cloud?

Cloudflare's primitives are powerful but require significant manual setup: creating `wrangler.json` configs, manually provisioning D1 databases / KV namespaces / R2 buckets, writing a monolithic `fetch` handler, and managing bindings across environments.

Vite Cloud eliminates all of that:

- **Zero config** — no `wrangler.json`, no dashboard clicks. Write code, deploy.
- **Automatic provisioning** — reference `c.env.DB` in a handler and a D1 database is created for you. Same for KV and R2.
- **File-based routing** — drop a file in `routes/`, get an endpoint. Method suffixes, dynamic params, middleware, and catch-alls built in.
- **Local dev parity** — `vite dev` runs your handlers in the real `workerd` runtime with local D1 (SQLite), KV, and R2. What works locally works in production.
- **One-command deploy** — `npx vcd deploy` builds, provisions resources, runs migrations, and deploys. No intermediate steps.

## Flexible by design

Vite Cloud adapts to your app's complexity rather than imposing a single architecture.

### SPA + API routes

The default starting point. Build your frontend with any UI library (React, Vue, Svelte, Solid, etc.) and add [Hono](https://hono.dev)-based API routes in `routes/`. Hono's full middleware ecosystem — CORS, auth, rate limiting, validation — works out of the box. This covers the majority of apps: a static frontend backed by serverless API endpoints with D1/KV/R2 access.

### Custom SSR / SSG

When you need server-rendered HTML, Vite Cloud provides the plumbing without dictating the framework. Add `src/main.ssr.ts` and `src/main.client.ts`, implement a `render(c, assetTags)` function, and Vite Cloud handles the rest — asset injection, dev HMR, and production builds. You can also export a `prerender` list for static generation. This is fully framework-agnostic: use `react-dom/server`, `vue/server-renderer`, or any library that produces HTML.

### Meta-framework integration

If you prefer a full meta-framework, Vite Cloud works as a deployment layer for frameworks that target Cloudflare Workers. TanStack Start is supported today, with React Router v7 support coming soon. In this mode, the framework owns routing and rendering while Vite Cloud handles provisioning, deployment, and infrastructure.

## How it works

```
vite.config.ts          →  viteCloud() plugin
routes/api/users.ts     →  API endpoint at /api/users
c.env.DB                →  D1 database (auto-provisioned)
c.env.KV                →  KV namespace (auto-provisioned)
c.env.STORAGE           →  R2 bucket (auto-provisioned)
migrations/*.sql        →  Applied to D1 on dev startup and deploy
npx vcd deploy          →  Live at https://<slug>.vitecloud.app
```

The plugin scans your source code at build time, infers which Cloudflare bindings you use, provisions them on deploy, and routes requests through a generated [Hono](https://hono.dev) app with lazy-loaded handlers for minimal cold starts.

## Next steps

- [Quickstart](./quickstart.md) — get a running app in minutes
- [Routing](./routing.md) — file-based routing, middleware, and Hono integration
- [Cloudflare Env](./cloudflare-env.md) — D1, KV, and R2 bindings
- [SSR](./ssr.md) — server-side rendering
- [SSG](./ssg.md) — static site generation / prerendering
- [CLI](./cli.md) — deploy, login, and project management
