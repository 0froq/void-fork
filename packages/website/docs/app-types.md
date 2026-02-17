# App Types

Vite Cloud supports three types of apps:

1. Full-stack Vite apps with Cloudflare Workers backend, optionally with SSR or SSG
2. Vite single-page application (frontend only)
3. Any Static site generator that output static assets, e.g. [Vitepress](https://vitepress.dev/)

The type is auto-detected from your project structure, or you can set it explicitly in [`vite-cloud.json`](./config.md).

## Vite Full-Stack

A Vite app with backend code that runs on Cloudflare Workers. This is the default when your project has API routes, SSR, jobs, or any server-side logic.

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

```bash
vcd deploy
```

Your worker handles API routes and (optionally) SSR. Static assets are served from the edge via R2. Cloudflare bindings (D1, KV, R2) are inferred from your source code and provisioned automatically.

**Detected when any of these exist:**

- `routes/` directory
- `jobs/` directory
- SSR entry (`src/main.ssr.ts` or `src/main.ssr.tsx`)

## Meta Frameworks

Vite cloud also supports Vite-based full-stack meta frameworks that have first-class Cloudflare integration, e.g. [Tanstack Start](https://tanstack.com/start/latest).

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

```bash
vcd deploy
```

Vite Cloud detects that `vite` is a dependency and no backend files exist, runs `vite build`, and deploys `dist/` as a SPA.

**Detected when:**

- `vite` is in your dependencies
- No backend files exist (`routes/`, `jobs/`, SSR entry)

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

```bash
vcd deploy
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

When no `mode` is set in `vite-cloud.json`, the detection logic runs in this order:

| Priority | Condition                                           | Type                               |
| -------- | --------------------------------------------------- | ---------------------------------- |
| 1        | `--dir` flag                                        | SSG (or SPA with `--spa`)          |
| 2        | `vitepress` in dependencies                         | SSG, builds with `vitepress build` |
| 3        | Backend files exist (`routes/`, `jobs/`, SSR entry) | Full-stack                         |
| 4        | `vite` in dependencies, no backend files            | SPA, builds with `vite build`      |
| 5        | `dist/index.html` or `./index.html` exists          | SSG (no build step)                |

## Explicit Configuration

To lock the app type and skip auto-detection, set `mode` in [`vite-cloud.json`](./config.md):

```json
{
  "mode": "ssg",
  "outputDir": ".vitepress/dist"
}
```

- `mode`: `"spa"`, `"ssg"`, or `"full"`
- `outputDir`: output directory for static modes (relative to project root, defaults to `"dist"`)
