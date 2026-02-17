# Deployment Modes

Vite Cloud supports three deployment modes. The mode is auto-detected on first deploy and persisted in `.vite-cloud/project.json`, so subsequent deploys use the same mode automatically.

## Full (Worker + Assets)

The default for projects using the `vite-cloud` plugin with support for [API routes](./routing.md), [SSR](./ssr.md), [SSG](./ssg.md), [jobs](./jobs.md), or any backend code that runs in Cloudflare Workers. This is what [Quickstart](./quickstart.md) walks through.

```bash
vcd deploy
```

Pipeline:

1. `vite build` (produces worker + client assets)
2. Infer bindings, collect migrations, scan jobs
3. Upload worker to Cloudflare Workers for Platforms
4. Upload static assets to R2
5. Provision resources (D1, KV, R2) as needed

Full deploys are detected when any of these exist:

- `routes/` directory
- `jobs/` directory
- SSR entry (`src/main.ssr.ts` or `src/main.ssr.tsx`)

## Static SPA

For client-side routed single-page apps without backend code. Unknown paths serve `index.html` so client-side routing (React Router, Vue Router, etc.) works.

Auto-detected when `vite` is in your dependencies but no backend files exist:

```bash
# Auto-detected Vite SPA
vcd deploy

# Explicit: deploy any directory as SPA
vcd deploy --dir dist --spa
```

At the edge, every request that doesn't match a static file falls back to `index.html` with a 200 status.

## Static SSG

For statically generated sites where each page has its own HTML file. This is the default for VitePress sites and `--dir` deploys.

```bash
# VitePress (auto-detected)
vcd deploy

# Explicit directory
vcd deploy --dir build
```

At the edge, the resolution order is:

1. Exact file path (`/styles.css` -> `styles.css`)
2. Nested index (`/about` -> `about/index.html`)
3. `404.html` with **status 404** (if the file exists)
4. Plain 404 response

This means VitePress's generated `404.html` page works out of the box.

## CLI Flags

| Flag           | Effect                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| `--dir <path>` | Deploy a pre-built directory. Skips the build step. Defaults to SSG mode.    |
| `--spa`        | Use SPA mode instead of SSG. Combine with `--dir` or use alone to force SPA. |

Examples:

```bash
# Deploy a VitePress site (auto-detected)
vcd deploy

# Deploy a pre-built directory as SSG
vcd deploy --dir .vitepress/dist

# Deploy a pre-built directory as SPA
vcd deploy --dir build --spa

# Force SPA mode on a Vite project
vcd deploy --spa
```

## Auto-Detection

The detection logic runs in this order:

| Priority | Condition                                           | Mode                               |
| -------- | --------------------------------------------------- | ---------------------------------- |
| 1        | `--dir` flag                                        | SSG (or SPA with `--spa`)          |
| 2        | `vitepress` in dependencies                         | SSG, builds with `vitepress build` |
| 3        | Backend files exist (`routes/`, `jobs/`, SSR entry) | Full                               |
| 4        | `vite` in dependencies, no backend files            | SPA, builds with `vite build`      |
| 5        | `dist/index.html` or `./index.html` exists          | SSG (no build step)                |

## Configuring the mode

To lock the deployment mode (and skip auto-detection), set `mode` in [`vite-cloud.json`](./config.md):

```json
{
  "mode": "ssg",
  "outputDir": ".vitepress/dist"
}
```

- `mode`: `"spa"`, `"ssg"`, or `"full"`
- `outputDir`: output directory for static modes (relative to project root, defaults to `"dist"`)

If `mode` is omitted, it is auto-detected on each deploy.

## Detection Presets

### VitePress

VitePress sites are detected automatically when `vitepress` is in your `package.json` dependencies. Vite Cloud will:

1. Detect the source directory (`.vitepress/` at root, or `docs/.vitepress/`)
2. Run `vitepress build` (or `vitepress build docs` for the `docs/` layout)
3. Deploy the output as SSG

```bash
cd my-vitepress-site
vcd login
vcd deploy
```

No configuration needed.

### Plain Vite SPA

A standard Vite project (React, Vue, Svelte, etc.) without `vite-cloud` routes is deployed as a static SPA:

```bash
cd my-react-app
npm install  # vite is in dependencies
vcd login
vcd deploy
```

Vite Cloud detects that `vite` is a dependency and no backend files exist, runs `vite build`, and deploys `dist/` as a SPA.

### Pre-Built Sites

If you have a pre-built static site (from any build tool), point `--dir` at the output:

```bash
vcd deploy --dir public
```

No build step runs. All files in the directory are uploaded as static assets.
