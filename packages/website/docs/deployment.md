# Deployment

## CLI

### First deploy

```bash
npm i -g vite-cloud   # or use npx vcd
vcd login              # OAuth via GitHub or Google
vcd deploy             # auto-detects app type, builds, deploys
```

On first deploy, the CLI prompts you to create or select a project. The project link is saved to `.vite-cloud/project.json` for subsequent deploys.

### Flags

```bash
vcd deploy [--project <name>] [--dir <path>] [--spa]
```

| Flag               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `--project <name>` | Target a specific project by slug                 |
| `--dir <path>`     | Deploy a pre-built static directory (skips build) |
| `--spa`            | Use SPA mode instead of SSG for static deploys    |

### Project resolution

The CLI resolves which project to deploy to in this order:

1. `--project <name>` flag
2. `VITE_CLOUD_PROJECT` environment variable
3. Linked project in `.vite-cloud/project.json`

If none match, the CLI prompts interactively.

### Environment variables

| Variable             | Purpose                          |
| -------------------- | -------------------------------- |
| `VITE_CLOUD_TOKEN`   | Auth token (for CI, skips OAuth) |
| `VITE_CLOUD_PROJECT` | Project slug override            |

## GitHub Actions

You can deploy from a GitHub repo with a simple GitHub Actions workflow:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install
      - run: pnpm vcd deploy
        env:
          VITE_CLOUD_TOKEN: ${{ secrets.VITE_CLOUD_TOKEN }}
          VITE_CLOUD_PROJECT: my-app
```

To get a deploy token, run `vcd token` to copy it to your clipboard, then add it as a GitHub Actions secret.

## Deploy Pipeline

### Full-stack

For projects with API routes, SSR, jobs, or any backend code:

```
vcd deploy
  │
  ├─ 1. Build
  │    vite build → dist/client/ (static assets)
  │                 dist/<worker>/ (worker bundle)
  │
  ├─ 2. Analyze
  │    ├─ Infer Cloudflare bindings (D1, KV, R2) from source
  │    ├─ Collect and validate migrations from migrations/*.sql
  │    ├─ Scan for scheduled jobs (cron triggers)
  │    └─ Detect SSR entry (src/main.ssr.ts)
  │
  ├─ 3. Check assets
  │    Compare SHA-256 hashes — only upload changed files
  │
  ├─ 4. Upload
  │    POST /projects/:id/deploy (multipart)
  │    ├─ manifest (bindings, migrations, schedules, headers)
  │    ├─ worker:<path> (worker JS modules)
  │    └─ asset:<path> (static files)
  │
  ├─ 5. Platform provisions
  │    ├─ Create D1/KV/R2 resources if needed
  │    ├─ Apply migrations to remote D1 (if any)
  │    ├─ Upload assets to R2
  │    ├─ Deploy worker to dispatch namespace
  │    └─ Update edge routing (KV)
  │
  └─ 6. Live
       https://my-app.vitecloud.app
```

**Key invariant:** The worker is never deployed unless all migrations succeed. On migration failure, the deployment is marked as failed and the existing worker keeps running.

Framework mode (TanStack Start, React Router) follows the same pipeline but skips the Hono routing layer — the framework owns routing and SSR.

### Static SPA

For client-side apps without backend code:

```
vcd deploy
  │
  ├─ 1. Build
  │    vite build → dist/ (static assets)
  │
  ├─ 2. Check assets
  │    Compare SHA-256 hashes — only upload changed files
  │
  ├─ 3. Upload
  │    POST /projects/:id/deploy (multipart)
  │    ├─ manifest (mode: "spa", headers, asset hashes)
  │    └─ asset:<path> (static files)
  │
  ├─ 4. Platform stores assets in R2
  │    Update edge routing (KV)
  │
  └─ 5. Live
       https://my-app.vitecloud.app
       All non-file paths → index.html (200)
```

### Static SSG

For statically generated sites (VitePress, etc.):

```
vcd deploy
  │
  ├─ 1. Build
  │    vitepress build → .vitepress/dist/ (or custom outputDir)
  │
  ├─ 2. Check assets
  │    Compare SHA-256 hashes — only upload changed files
  │
  ├─ 3. Upload
  │    POST /projects/:id/deploy (multipart)
  │    ├─ manifest (mode: "ssg", headers, asset hashes)
  │    └─ asset:<path> (static files)
  │
  ├─ 4. Platform stores assets in R2
  │    Update edge routing (KV)
  │
  └─ 5. Live
       https://my-app.vitecloud.app
       /about → about/index.html
       /missing → 404.html (404)
```

### Pre-built directories

Skip the build step entirely with `--dir`:

```bash
vcd deploy --dir public         # SSG mode (default)
vcd deploy --dir build --spa    # SPA mode
```

The CLI uploads all files from the directory directly — no build command runs.

## Asset Deduplication

On every deploy, the CLI computes SHA-256 hashes for all assets and sends them to the platform. The platform responds with which files are already cached. Only new or changed files are uploaded. This makes re-deploys with few changes very fast.

## Edge Invalidation

Each deploy creates a new version identifier. Edge-cached responses use versioned cache keys, so new deploys are instantly visible without cache purge APIs. See [Caching and Headers](./cache.md) for details on cache behavior.
