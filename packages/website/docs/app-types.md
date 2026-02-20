# App Types

Vite Cloud supports four types of apps:

1. Vite apps with optional Cloudflare Workers backend
2. Vite-based meta frameworks that can run on Cloudflare, e.g. [Tanstack Start](https://tanstack.com/start/latest)
3. Any Static site generator that output static assets, e.g. [Vitepress](https://vitepress.dev/)

The type is auto-detected from your project structure, or you can set it explicitly in [`vite-cloud.json`](./config.md).

## Vite Full-Stack

A Vite app with backend code that runs on Cloudflare Workers. This is the default when your project has API routes, SSR, SSG, jobs, or any server-side logic. In this mode, **Vite Cloud is both the framework and the platform**. This opinionated setup unlocks some developer experience perks that are unique to Vite Cloud, while still staying frontend-framework-agnostic. You can use it with any frontend framework that works with Vite: React, Vue, Svelte, or Solid.

All Vite Cloud features that involve backend logic, such as [Routing](./routing.md) and [Authentication](./auth.md), are only available in this mode.

```
my-app/
  src/
    App.tsx
  routes/
    api/
      hello.ts          ← export const GET = defineHandler(...)
      users/
        index.ts         ← export const GET, POST
        [id].ts          ← export const GET
  middleware/
    logger.ts
  migrations/
    001_create_users.sql
  vite.config.ts         ← plugins: [viteCloud()]
```

Your worker handles API routes and (optionally) SSR. Static assets are served from the edge via R2. Cloudflare bindings (D1, KV, R2) are inferred from your source code and provisioned automatically.

**Detected when any of these exist:**

- `routes/` directory
- `jobs/` directory
- SSR entry (`src/main.ssr.ts` or `src/main.ssr.tsx`)

## Vite SPA

A client-side single-page app without backend code. All paths that don't match a static file fall back to `index.html` with a 200 status, so client-side routing (React Router, Vue Router, etc.) works out of the box.

```
my-react-app/
  src/
    App.tsx
    main.tsx
  index.html
  vite.config.ts
  package.json           ← vite in dependencies, no routes/
```

Vite Cloud detects that `vite` is a dependency and no backend files exist, runs `vite build`, and deploys `dist/` as a SPA.

**Detected when:**

- `vite` is in your dependencies
- No backend files exist (`routes/`, `jobs/`, SSR entry)

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

## Static Site

A statically generated site where each page has its own HTML file. This is the default for VitePress sites and `--dir` deploys.

```
my-docs/
  docs/
    index.md
    guide/
      getting-started.md
    .vitepress/
      config.ts
  package.json           ← vitepress in dependencies
```

At the edge, the resolution order is:

1. Exact file path (`/styles.css` → `styles.css`)
2. Nested index (`/about` → `about/index.html`)
3. `404.html` with **status 404** (if the file exists)
4. Plain 404 response

**Detected when:**

- `vitepress` is in your dependencies, **or**
- `--dir` flag is used, **or**
- `dist/index.html` or `./index.html` exists (no build tool detected)

## Auto-Detection

When running `vcc deploy` and no `mode` is set in `vite-cloud.json`, the detection logic runs in this order:

| Priority | Condition                                              | Type                               |
| -------- | ------------------------------------------------------ | ---------------------------------- |
| 1        | `--dir` flag                                           | SSG (or SPA with `--spa`)          |
| 2        | `vitepress` in dependencies                            | SSG, builds with `vitepress build` |
| 3        | `@tanstack/react-start` or `@react-router/dev` in deps | Framework                          |
| 4        | Backend files exist (`routes/`, `jobs/`, SSR entry)    | Full-stack                         |
| 5        | `vite` in dependencies, no backend files               | SPA, builds with `vite build`      |
| 6        | `dist/index.html` or `./index.html` exists             | SSG (no build step)                |

## Explicit Configuration

To lock the app type and skip auto-detection, set `mode` in [`vite-cloud.json`](./config.md):

```json
{
  "mode": "ssg",
  "outputDir": ".vitepress/dist"
}
```

- `mode`: `"spa"`, `"ssg"`, `"fullstack"`, or `"framework"`
- `outputDir`: output directory for static modes (relative to project root, defaults to `"dist"`)
