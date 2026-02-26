---
outline: deep
---

# Supported App Types

Void supports three types of apps:

1. **Void apps** — Vite apps powered by Void's framework layer ([API routes](./server-routing.md), [pages mode](./pages-routing/overview.md), [auth](./auth.md), [crons](./jobs.md), [queues](./queues.md))
2. **Meta frameworks** — [TanStack Start](https://tanstack.com/start/latest), [React Router](https://reactrouter.com/), [SvelteKit](https://svelte.dev/docs/kit), [Nuxt](https://nuxt.com/), [Astro](https://astro.build/)
3. **Static sites** — SPAs, prebuilt sites like [VitePress](https://vitepress.dev/), or any directory of static files

The type is auto-detected from your project structure, or you can set it explicitly in [`void.json`](./config.md).

## Void Apps

A Vite app powered by Void's framework layer. In this mode, **Void is both the framework and the platform** — an opinionated setup that unlocks DX perks unique to Void, while staying frontend-framework-agnostic. You can use it with React, Vue, Svelte, Solid, or any frontend that works with Vite.

All Void features that involve backend logic — [server routing](./server-routing.md), [pages mode](./pages-routing/overview.md), [authentication](./auth.md), [typed fetch](./typed-fetch.md), [cron jobs](./jobs.md), [queues](./queues.md) — are available in this mode.

A Void app can be **API-only** (just `routes/`), a **SPA + API** (frontend in `src/` with API routes), or **full-stack with pages mode** (server-rendered pages in `pages/` with co-located data loading):

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
  vite.config.ts            ← plugins: [voidPlugin()]
```

Your worker handles API routes, page rendering, and (optionally) [custom SSR](./ssr.md). Static assets are served from the edge via R2. Cloudflare bindings (D1, KV, R2) are [inferred from your source code](./resource-inference.md) and provisioned automatically.

**Detected when any of these exist:**

- `routes/` directory
- `pages/` directory
- `middleware/` directory
- `crons/` directory
- `queues/` directory
- Custom SSR entry (`src/main.ssr.ts` or `src/main.ssr.tsx`)

## Meta Frameworks

Void supports deploying Vite-based meta-framework apps via `void deploy`. The framework owns routing and SSR — Void handles [binding inference](./resource-inference.md), [typed DB queries](./db.md), migrations, and deployment.

| Framework                                           | Detected from package   | Setup guide                                          |
| --------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| [TanStack Start](https://tanstack.com/start/latest) | `@tanstack/react-start` | [Guide](./integrations/frameworks/tanstack-start.md) |
| [React Router v7](https://reactrouter.com/)         | `@react-router/dev`     | [Guide](./integrations/frameworks/react-router.md)   |
| [SvelteKit](https://svelte.dev/docs/kit)            | `@sveltejs/kit`         | [Guide](./integrations/frameworks/sveltekit.md)      |
| [Nuxt](https://nuxt.com/)                           | `nuxt`                  | [Guide](./integrations/frameworks/nuxt.md)           |
| [Astro](https://astro.build/)                       | `astro`                 | [Guide](./integrations/frameworks/astro.md)          |

Add `voidPlugin()` to the framework's Vite config to get binding inference, typed DB generation, and migration management during dev. See the [Meta Frameworks Integration](./integrations/frameworks/overview.md) for the full feature matrix, deploy pipeline, and per-framework setup guides.

**Detected when** any of the above packages is in your dependencies.

## Pre-built Static Sites

Any project that produces static files — SPAs, prebuilt sites, or plain directories. No Cloudflare Worker is deployed; assets are served directly from the edge.

**SPAs** (client-side single-page apps) fall back all non-file paths to `index.html` with a 200 status, so client-side routing works out of the box. Detected when `vite` is a dependency and no backend files exist.

**Prebuilt sites** (static site generators like VitePress, or any pre-built directory) produce per-page HTML files. Detected when `vitepress` is a dependency, or when using the `--dir` flag.

At the edge, the resolution order is:

1. Exact file path (`/styles.css` → `styles.css`)
2. Nested index (`/about` → `about/index.html`)
3. `404.html` with **status 404** (if the file exists)
4. Plain 404 response

## Auto-Detection

When running `void deploy` and no `mode` is set in `void.json`, the detection logic runs in this order:

| Priority | Condition                                                                                 | Type                                    |
| -------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| 1        | `--dir` flag                                                                              | Prebuilt (or SPA with `--spa`)          |
| 2        | `vitepress` in dependencies                                                               | Prebuilt, builds with `vitepress build` |
| 3        | `@tanstack/react-start`, `@react-router/dev`, `@sveltejs/kit`, `nuxt`, or `astro` in deps | Framework                               |
| 4        | Backend files exist (`routes/`, `pages/`, `middleware/`, `crons/`, `queues/`, SSR entry)  | Void app                                |
| 5        | `vite` in dependencies, no backend files                                                  | SPA, builds with `vite build`           |
| 6        | `dist/index.html` or `./index.html` exists                                                | Prebuilt (no build step)                |

## Explicit Configuration

To lock the app type and skip auto-detection, set `mode` in [`void.json`](./config.md):

```json
{
  "mode": "prebuilt",
  "outputDir": ".vitepress/dist"
}
```

- `mode`: `"fullstack"`, `"framework"`, `"spa"`, or `"prebuilt"`
- `outputDir`: output directory for static modes (relative to project root, defaults to `"dist"`)
