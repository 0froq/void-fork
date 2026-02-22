# Operations

How we deploy, what we provision, and how the system is configured.

## What We Deploy

Three Cloudflare Workers plus a static docs site:

| Worker                | Package             | Purpose                                                                                                        |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `vite-cloud-ai-proxy` | `packages/ai-proxy` | AI inference proxy — holds the real `AI` binding, injects AI Gateway metadata for metering                     |
| `vite-cloud-platform` | `packages/platform` | Control Plane API + Admin Dashboard — OAuth, project CRUD, deploy pipeline, usage metering                     |
| `vite-cloud-dispatch` | `packages/dispatch` | Edge router — routes `*.vitecloud.app` traffic to user workers (via Workers for Platforms) or R2 static assets |
| Docs (VitePress)      | `packages/website`  | Static site deployed as a Vite Cloud project via `vcc deploy`                                                  |

## Environments

Two fully isolated environments. Each has its own CF resources (D1, KV, R2, dispatch namespace, analytics engine).

| Environment    | Platform URL                  | User Sites                | Trigger                      |
| -------------- | ----------------------------- | ------------------------- | ---------------------------- |
| **Production** | `platform.vite.cloud`         | `*.vitecloud.app`         | Push to `prod` branch        |
| **Staging**    | `platform.staging.vite.cloud` | `*.staging.vitecloud.app` | Push to `main` branch (auto) |

## Cloudflare Resources

### Production

**Platform worker** (`vite-cloud-platform`):

| Resource           | Binding    | Name / ID                                                      |
| ------------------ | ---------- | -------------------------------------------------------------- |
| D1 Database        | `DB`       | `vite-cloud-platform` (`f85c1d7d-7b41-4f85-88e5-ad37966825e7`) |
| R2 Bucket          | `ASSETS`   | `vite-cloud-assets`                                            |
| KV Namespace       | `ROUTING`  | `9250c33f3db6494ebe8ad6272812c8c0`                             |
| Dispatch Namespace | `DISPATCH` | `vite-cloud-users`                                             |
| Cron Trigger       | —          | `*/5 * * * *`                                                  |

**Dispatch worker** (`vite-cloud-dispatch`):

| Resource           | Binding     | Name / ID                                                      |
| ------------------ | ----------- | -------------------------------------------------------------- |
| Dispatch Namespace | `DISPATCH`  | `vite-cloud-users`                                             |
| R2 Bucket          | `ASSETS`    | `vite-cloud-assets`                                            |
| KV Namespace       | `ROUTING`   | `9250c33f3db6494ebe8ad6272812c8c0`                             |
| Analytics Engine   | `ANALYTICS` | `vite_cloud_requests`                                          |
| Routes             | —           | `*.vitecloud.app/*`, `*.vitecloud.app` (zone: `vitecloud.app`) |

**AI proxy worker** (`vite-cloud-ai-proxy`):

| Resource   | Binding | Name / ID                                                                    |
| ---------- | ------- | ---------------------------------------------------------------------------- |
| Workers AI | `AI`    | (account-level)                                                              |
| AI Gateway | —       | `vite-cloud` (shared, account-level)                                         |
| Routes     | —       | `ai-proxy.vitecloud.app/*`, `ai-proxy.vitecloud.app` (zone: `vitecloud.app`) |

All workers: `compatibility_date: 2026-02-12`, `compatibility_flags: ["nodejs_compat"]`, `observability: enabled`.

### Staging

Same resource types with `-staging` suffixes:

| Resource    | Platform                                                               | Dispatch                                               | AI Proxy                                                             |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| D1          | `vite-cloud-platform-staging` (`e78b32c1-497a-40ad-8f83-7049e139983e`) | —                                                      | —                                                                    |
| R2          | `vite-cloud-assets-staging`                                            | `vite-cloud-assets-staging`                            | —                                                                    |
| KV          | `60240eecea804f39bf8b7395cd6c6b08`                                     | `60240eecea804f39bf8b7395cd6c6b08`                     | —                                                                    |
| Dispatch NS | `vite-cloud-users-staging`                                             | `vite-cloud-users-staging`                             | —                                                                    |
| Analytics   | —                                                                      | `vite_cloud_requests_staging`                          | —                                                                    |
| Workers AI  | —                                                                      | —                                                      | `AI` (account-level)                                                 |
| Routes      | —                                                                      | `*.staging.vitecloud.app/*`, `*.staging.vitecloud.app` | `ai-proxy.staging.vitecloud.app/*`, `ai-proxy.staging.vitecloud.app` |

## Secrets and Environment Variables

All secrets are stored in a dedicated 1Password vault.

### Platform Worker Secrets

Set via `wrangler secret put <NAME>` (separate values per environment):

| Secret                 | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `CF_API_TOKEN`         | Cloudflare API token (see permissions below) |
| `CF_ACCOUNT_ID`        | Cloudflare account ID                        |
| `CF_ZONE_ID`           | DNS zone ID (`vitecloud.app` zone)           |
| `JWT_SECRET`           | Signs auth JWTs                              |
| `GITHUB_CLIENT_ID`     | GitHub OAuth app client ID                   |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret               |
| `GOOGLE_CLIENT_ID`     | Google OAuth app client ID                   |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app client secret               |

**Platform worker `CF_API_TOKEN` permissions** — this is the broad-scope token used at runtime to provision and manage user resources. Separate from the GitHub Actions deploy token.

Account-level:

| Permission         | Access | Operations                                             |
| ------------------ | ------ | ------------------------------------------------------ |
| Workers Scripts    | Edit   | Upload/delete user workers in dispatch namespace       |
| D1                 | Edit   | Create databases, execute migrations, delete databases |
| Workers KV Storage | Edit   | Create/delete KV namespaces                            |
| Workers R2 Storage | Edit   | Create/delete R2 buckets                               |
| Queues             | Edit   | Create/delete queues, manage queue consumers           |
| Account Analytics  | Read   | Query Analytics Engine SQL API for usage metering      |

Zone-level (on `vitecloud.app`):

| Permission           | Access | Operations                                  |
| -------------------- | ------ | ------------------------------------------- |
| SSL and Certificates | Edit   | Custom hostname DV certificate provisioning |

### AI Proxy Worker Secrets

Set via `wrangler secret put <NAME>` (same value as platform's `JWT_SECRET`):

| Secret       | Purpose                                   |
| ------------ | ----------------------------------------- |
| `JWT_SECRET` | Verifies auth JWTs from local dev clients |

### Configurable Environment Variables

Set via `vars` in `wrangler.jsonc` (production uses defaults, staging overrides):

| Worker   | Variable             | Default                                     | Staging Override                                    | Purpose                                           |
| -------- | -------------------- | ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| platform | `DISPATCH_NAMESPACE` | `vite-cloud-users`                          | `vite-cloud-users-staging`                          | CF dispatch namespace name                        |
| platform | `SITE_DOMAIN`        | `vitecloud.app`                             | `staging.vitecloud.app`                             | Base domain for deploy URL output                 |
| platform | `AUTH_REDIRECT_URI`  | `https://platform.vite.cloud/auth/callback` | `https://platform.staging.vite.cloud/auth/callback` | OAuth callback URL                                |
| platform | `SIGNUP_ALLOWLIST`   | (unset)                                     | `@voidzero.dev`                                     | Comma-separated emails/domains for new signups    |
| platform | `DEV_AUTH_BYPASS`    | (unset)                                     | —                                                   | Skip admin OAuth for local dev (`.dev.vars` only) |
| dispatch | `BASE_HOSTNAME`      | `vitecloud.app`                             | `staging.vitecloud.app`                             | Base hostname for slug extraction                 |

### GitHub Actions Secrets

| Secret             | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `CF_API_TOKEN`     | Cloudflare API token (see permissions below)              |
| `CF_ACCOUNT_ID`    | Cloudflare account ID (passed as `CLOUDFLARE_ACCOUNT_ID`) |
| `VITE_CLOUD_TOKEN` | Auth token for deploying docs via `vcc deploy`            |

**GitHub Actions `CF_API_TOKEN` permissions** — narrower-scope token used only for wrangler deploys. Separate from the platform worker runtime token.

Account-level:

| Permission         | Access | Operations                                             |
| ------------------ | ------ | ------------------------------------------------------ |
| Workers Scripts    | Edit   | Deploy platform and dispatch workers                   |
| D1                 | Edit   | Run remote migrations (`wrangler d1 migrations apply`) |
| Workers KV Storage | Edit   | Bind KV namespaces during deploy                       |
| Workers R2 Storage | Edit   | Bind R2 buckets during deploy                          |

Zone-level (on `vitecloud.app`):

| Permission     | Access | Operations                                               |
| -------------- | ------ | -------------------------------------------------------- |
| Workers Routes | Edit   | Set dispatch worker route patterns (`*.vitecloud.app/*`) |
| DNS            | Read   | Zone lookup for route binding                            |

### CLI Staging Mode

Internal-only toggle for pointing the CLI at staging. Not documented in public docs.

- `vcc staging on` — sets `"staging": true` in `~/.vite-cloud/config.json`
- Reads/writes `stagingToken` instead of `token`
- Defaults API URL to `https://platform.staging.vite.cloud`
- Can also be activated via `STAGING=1` env var or `VITE_CLOUD_API_URL` env var

## Deploy Process

### Deploy Scripts

Root `package.json` orchestrates deployment:

```
pnpm run deploy           # Production: deploy ai-proxy, dispatch, then migrate + deploy platform
pnpm run deploy:staging   # Staging: same with --env staging
```

Broken down:

```
deploy
├── deploy:ai-proxy         → pnpm -F @vite-cloud/ai-proxy run deploy  (wrangler deploy)
├── deploy:dispatch         → pnpm -F dispatch run deploy               (wrangler deploy)
└── deploy:platform         → pnpm -F platform migrate                  (wrangler d1 migrations apply --remote)
                            → pnpm -F platform run deploy               (wrangler deploy)

deploy:staging
├── deploy:staging:ai-proxy → pnpm -F @vite-cloud/ai-proxy run deploy --env staging
├── deploy:staging:dispatch → pnpm -F dispatch run deploy --env staging
└── deploy:staging:platform → pnpm -F platform migrate:staging          (wrangler d1 migrations apply --env staging --remote)
                            → pnpm -F platform run deploy --env staging
```

Deploy order matters: ai-proxy deploys first (user workers depend on it via service binding), dispatch deploys next (stateless router), then platform runs D1 migrations before deploying (ensures schema is ready for new code).

### GitHub Actions

Three workflows in `.github/workflows/`:

**`ci.yml`** — runs on PRs to `main` and as a reusable workflow:

1. Install pnpm + Node.js (from `.node-version`)
2. `pnpm install --frozen-lockfile`
3. `pnpm -r build` (build all packages)
4. `pnpm lint` (oxlint)
5. `pnpm check` (typecheck all packages)
6. Install Playwright Chromium
7. `pnpm test` (full test suite)

**`deploy.yml`** — runs on push to `prod` (production):

1. Runs CI workflow first
2. `pnpm run deploy` (dispatch + platform workers)
3. `pnpm build:cli && pnpm i` (build CLI — docs deploy depends on it)
4. `pnpm deploy:docs` (deploy VitePress docs as a Vite Cloud project)

**`deploy-staging.yml`** — runs on push to `main` (staging):

1. Runs CI workflow first
2. `pnpm run deploy:staging` (dispatch + platform workers to staging)
3. `pnpm build:cli && pnpm i`
4. `pnpm deploy:staging:docs` (deploy docs to staging project)

Note: staging docs are hosted on the production platform (as a separate Vite Cloud project `vite-cloud-staging`), not on the staging platform.

### Health Checks

```
pnpm health            # Check production platform health
pnpm health:staging    # Check staging platform health
```

## DNS Setup

| Record                           | Zone            | Points To                                |
| -------------------------------- | --------------- | ---------------------------------------- |
| `platform.vite.cloud`            | `vite.cloud`    | Platform worker                          |
| `*.vitecloud.app`                | `vitecloud.app` | Dispatch worker (wildcard route)         |
| `ai-proxy.vitecloud.app`         | `vitecloud.app` | AI proxy worker                          |
| `platform.staging.vite.cloud`    | `vite.cloud`    | Staging platform worker                  |
| `*.staging.vitecloud.app`        | `vitecloud.app` | Staging dispatch worker (wildcard route) |
| `ai-proxy.staging.vitecloud.app` | `vitecloud.app` | Staging AI proxy worker                  |

## Fresh Environment Setup

Steps to provision a new environment from scratch (e.g. reproducing staging):

1. **Create CF resources** (all with environment suffix):
   - D1 database
   - KV namespace
   - R2 bucket
   - Dispatch namespace (Workers for Platforms)
   - Analytics Engine dataset
   - AI Gateway named `vite-cloud`

2. **Update wrangler configs** — add an `env.<name>` section in `packages/platform/wrangler.jsonc`, `packages/dispatch/wrangler.jsonc`, and `packages/ai-proxy/wrangler.jsonc` with the new resource IDs.

3. **Set worker secrets** — for the platform worker:

   ```
   wrangler secret put CF_API_TOKEN --env <name>
   wrangler secret put CF_ACCOUNT_ID --env <name>
   wrangler secret put CF_ZONE_ID --env <name>
   wrangler secret put JWT_SECRET --env <name>
   wrangler secret put GITHUB_CLIENT_ID --env <name>
   wrangler secret put GITHUB_CLIENT_SECRET --env <name>
   wrangler secret put GOOGLE_CLIENT_ID --env <name>
   wrangler secret put GOOGLE_CLIENT_SECRET --env <name>
   ```

4. **DNS records** — on the `vitecloud.app` zone, add a wildcard CNAME for user sites. On the `vite.cloud` zone, add a CNAME for the platform API.

5. **OAuth callback URLs** — add the new platform URL as an authorized redirect in both the GitHub OAuth App and Google OAuth Client:
   - `https://<platform-host>/auth/callback`
   - `https://<platform-host>/admin/callback`

6. **GitHub Actions** — if CI/CD should deploy to this environment, add a workflow file and configure GitHub environment secrets (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `VITE_CLOUD_TOKEN`).

7. **Deploy** — run `pnpm run deploy --env <name>` or equivalent.
