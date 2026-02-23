---
outline: deep
---

# App Types

Vite Cloud supports three types of apps:

1. Vite apps that leverage Vite Cloud's backend ([API routes](./server-routing.md)) or full-stack ([pages mode](./pages-routing.md)) features
2. Other Vite-based meta frameworks that can run on Cloudflare, e.g. [TanStack Start](https://tanstack.com/start/latest), [React Router](https://reactrouter.com/)
3. Purely static sites — SPAs, SSGs like [VitePress](https://vitepress.dev/), or any directory of static files

The type is auto-detected from your project structure, or you can set it explicitly in [`vite-cloud.json`](./config.md).

## Vite Full-Stack

A Vite app with backend code that runs on Cloudflare Workers. In this mode, **Vite Cloud is both the framework and the platform** — an opinionated setup that unlocks DX perks unique to Vite Cloud, while staying frontend-framework-agnostic. You can use it with React, Vue, Svelte, Solid, or any frontend that works with Vite.

All Vite Cloud features that involve backend logic — [server routing](./server-routing.md), [pages mode](./pages-routing.md), [authentication](./auth.md), [typed fetch](./typed-fetch.md), [cron jobs](./jobs.md), [queues](./queues.md) — are only available in this mode.

A full-stack app can be **API-only** (just `routes/`), a **SPA + API** (frontend in `src/` with API routes), or **full-stack with pages mode** (server-rendered pages in `pages/` with co-located data loading):

```
my-app/
  pages/                   ← pages mode (SSR + SPA navigation)
    layout.vue
    index.vue
    index.server.ts
    users/
      index.vue
      index.server.ts
  routes/
    api/
      hello.ts             ← export const GET = defineHandler(...)
      users/
        index.ts            ← export const GET, POST
        [id].ts             ← export const GET
  middleware/
    01.auth.ts
  migrations/
    001_create_users.sql
  vite.config.ts            ← plugins: [viteCloud()]
```

Your worker handles API routes, page rendering, and (optionally) [custom SSR](./ssr.md). Static assets are served from the edge via R2. Cloudflare bindings (D1, KV, R2) are inferred from your source code and provisioned automatically.

**Detected when any of these exist:**

- `routes/` directory
- `pages/` directory
- `middleware/` directory
- `crons/` directory
- `queues/` directory
- Custom SSR entry (`src/main.ssr.ts` or `src/main.ssr.tsx`)

## Meta Frameworks

Vite Cloud supports [TanStack Start](https://tanstack.com/start/latest) and [React Router v7](https://reactrouter.com/), auto-detected from `package.json`. The framework owns routing and SSR — Vite Cloud handles binding inference, [typed DB queries](./db.md), migrations, and deployment.

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    viteCloud(), // must come before the framework plugin
    tanstackStart(),
    react(),
  ],
});
```

Access bindings via the `cloudflare:workers` module in server functions. The [typed query helper](./db.md) works the same as in full-stack mode — types are generated from your migrations:

```tsx
// src/routes/users.tsx
import { createServerFn } from "@tanstack/react-start";
import { db } from "vite-cloud/db";

const getUsers = createServerFn().handler(async () => {
  return db.list("users"); // fully typed from migrations
});
```

Features like `defineHandler`, file-based routing, auth, and the [typed fetch client](./typed-fetch.md) are not active in framework mode — the framework provides its own equivalents.

**Detected when** `@tanstack/react-start` or `@react-router/dev` is in your dependencies.

## Static Sites

Any project that produces static files — SPAs, SSGs, or plain directories. No Cloudflare Worker is deployed; assets are served directly from the edge.

**SPAs** (client-side single-page apps) fall back all non-file paths to `index.html` with a 200 status, so client-side routing works out of the box. Detected when `vite` is a dependency and no backend files exist.

**SSGs** (static site generators like VitePress) produce per-page HTML files. Detected when `vitepress` is a dependency, or when using the `--dir` flag.

At the edge, the resolution order is:

1. Exact file path (`/styles.css` → `styles.css`)
2. Nested index (`/about` → `about/index.html`)
3. `404.html` with **status 404** (if the file exists)
4. Plain 404 response

## Auto-Detection

When running `vcc deploy` and no `mode` is set in `vite-cloud.json`, the detection logic runs in this order:

| Priority | Condition                                                                                | Type                               |
| -------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| 1        | `--dir` flag                                                                             | SSG (or SPA with `--spa`)          |
| 2        | `vitepress` in dependencies                                                              | SSG, builds with `vitepress build` |
| 3        | `@tanstack/react-start` or `@react-router/dev` in deps                                   | Framework                          |
| 4        | Backend files exist (`routes/`, `pages/`, `middleware/`, `crons/`, `queues/`, SSR entry) | Full-stack                         |
| 5        | `vite` in dependencies, no backend files                                                 | SPA, builds with `vite build`      |
| 6        | `dist/index.html` or `./index.html` exists                                               | SSG (no build step)                |

## Explicit Configuration

To lock the app type and skip auto-detection, set `mode` in [`vite-cloud.json`](./config.md):

```json
{
  "mode": "ssg",
  "outputDir": ".vitepress/dist"
}
```

- `mode`: `"fullstack"`, `"framework"`, `"spa"`, or `"ssg"`
- `outputDir`: output directory for static modes (relative to project root, defaults to `"dist"`)
