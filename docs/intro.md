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

### vs. raw Cloudflare (Workers + Pages)

Cloudflare's primitives are powerful but require significant manual setup: creating `wrangler.json` configs, manually provisioning D1 databases / KV namespaces / R2 buckets, writing a monolithic `fetch` handler, and managing bindings across environments.

Vite Cloud eliminates all of that:

- **Zero config** — no `wrangler.json`, no dashboard clicks. Write code, deploy.
- **Automatic provisioning** — reference `c.env.DB` in a handler and a D1 database is created for you. Same for KV and R2.
- **File-based routing** — drop a file in `routes/`, get an endpoint. Method suffixes, dynamic params, middleware, and catch-alls built in.
- **Local dev parity** — `vite dev` runs your handlers in the real `workerd` runtime with local D1 (SQLite), KV, and R2. What works locally works in production.
- **One-command deploy** — `npx vcd deploy` builds, provisions resources, runs migrations, and deploys. No intermediate steps.

### vs. Vercel / Netlify

Traditional deployment platforms run your server code on Node.js (often behind Lambda). Vite Cloud runs on Cloudflare Workers — edge-first with sub-millisecond cold starts, globally distributed by default.

- **Edge runtime** — every request runs close to the user, not in a single region.
- **Integrated data layer** — D1, KV, and R2 are first-class, not bolt-on add-ons with separate billing.
- **Framework-agnostic** — works with React, Vue, Svelte, Solid, or plain HTML. No framework lock-in.
- **Transparent infrastructure** — your app runs on Cloudflare Workers. No proprietary runtime abstraction.

### vs. meta-frameworks (Next.js, Nuxt, SvelteKit)

Meta-frameworks bundle routing, rendering, and deployment into a single opinionated stack. Vite Cloud takes a different approach: it's a **Vite plugin**, not a framework.

- **Use any UI library** — Vite Cloud adds server capabilities to your existing Vite app. Keep your React, Vue, or Svelte setup as-is.
- **SPA, SSR, or SSG** — choose what fits your app. Static SPA with API routes? SSR with streaming? Pre-rendered pages? All supported, no framework opinion imposed.
- **Hono ecosystem** — route handlers run on [Hono](https://hono.dev), so its entire middleware ecosystem (CORS, auth, rate limiting, etc.) works out of the box.
- **Progressive adoption** — start with a static SPA, add an API route, add a database. Each step is one file change, not an architecture rewrite.

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
