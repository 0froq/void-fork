---
outline: deep
---

# Deployment

Void apps run on Cloudflare's infrastructure but you don't need to use your own Cloudflare account. Our long term goal is to provide a simpler app-centric deployment experience similar to that of Vercel and Netlify. But right now, Void only supports deploying via the CLI or GitHub actions.

## CLI

### First deploy

```bash
void login              # OAuth via GitHub or Google
void deploy             # auto-detects app type, builds, deploys
```

On first deploy, the CLI prompts you to create or select a project. The project link is saved to `.void/project.json` for subsequent deploys.

### Flags

```bash
void deploy [--project <name>] [--dir <path>] [--spa]
```

| Flag               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `--project <name>` | Target a specific project by slug                 |
| `--dir <path>`     | Deploy a pre-built static directory (skips build) |
| `--spa`            | Use SPA mode instead of SSG for static deploys    |

### Project resolution

The CLI resolves which project to deploy to in this order:

1. `--project <name>` flag
2. `VOID_PROJECT` environment variable
3. Linked project in `.void/project.json`

If none match, the CLI prompts interactively.

### Environment variables

| Variable       | Purpose                          |
| -------------- | -------------------------------- |
| `VOID_TOKEN`   | Auth token (for CI, skips OAuth) |
| `VOID_PROJECT` | Project slug override            |

## GitHub Actions

You can deploy from a GitHub repo with a simple GitHub Actions workflow. Running `void init --github` will generate this as `.github/workflows/deploy.yml` in your project:

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
      - run: pnpm void deploy
        env:
          VOID_TOKEN: ${{ secrets.VOID_TOKEN }}
          VOID_PROJECT: my-app
```

To get a deploy token, run `void token` to copy it to your clipboard, then add it as a GitHub Actions secret.

## Deploy Pipeline

### Full-stack

For projects with API routes, pages, queues, jobs, or any backend code:

```
void deploy
  │
  ├─ 1. Build
  │    vite build → dist/client/ (static assets)
  │                 dist/<worker>/ (worker bundle)
  │
  ├─ 2. Analyze
  │    ├─ Infer Cloudflare bindings (D1, KV, R2) from source
  │    ├─ Collect and validate migrations from migrations/*.sql
  │    ├─ Scan for scheduled jobs (cron triggers)
  │    ├─ Scan for queue consumers (queues/*.ts)
  │    └─ Detect custom SSR entry (src/main.ssr.ts)
  │
  ├─ 3. Check assets
  │    Compare SHA-256 hashes — only upload changed files
  │
  ├─ 4. Upload
  │    POST /projects/:id/deploy (multipart)
  │    ├─ manifest (bindings, migrations, schedules, queues, headers)
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
       https://my-app.voidcloud.dev
```

**Key invariant:** The worker is never deployed unless all migrations succeed. On migration failure, the deployment is marked as failed and the existing worker keeps running.

Framework mode follows the same pipeline but skips the Hono routing layer — the framework owns routing and SSR. TanStack Start and React Router build via Vite. SvelteKit, Nuxt, and Astro use their own build toolchains and output conventions — see [Frameworks Integration](./integrations/frameworks/overview.md) for the full deploy pipeline.

### Static SPA

For client-side apps without backend code:

```
void deploy
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
       https://my-app.voidcloud.dev
       All non-file paths → index.html (200)
```

### Static SSG

For statically generated sites (VitePress, etc.):

```
void deploy
  │
  ├─ 1. Build
  │    vitepress build → .vitepress/dist/ (or custom outputDir)
  │
  ├─ 2. Check assets
  │    Compare SHA-256 hashes — only upload changed files
  │
  ├─ 3. Upload
  │    POST /projects/:id/deploy (multipart)
  │    ├─ manifest (mode: "prebuilt", headers, asset hashes)
  │    └─ asset:<path> (static files)
  │
  ├─ 4. Platform stores assets in R2
  │    Update edge routing (KV)
  │
  └─ 5. Live
       https://my-app.voidcloud.dev
       /about → about/index.html
       /missing → 404.html (404)
```

### Pre-built directories

Skip the build step entirely with `--dir`:

```bash
void deploy --dir public         # SSG mode (default)
void deploy --dir build --spa    # SPA mode
```

The CLI uploads all files from the directory directly — no build command runs.
