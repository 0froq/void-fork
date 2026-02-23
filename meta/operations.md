# Operations

How we deploy, what we provision, and how the system is configured.

## Access Levels

| System                         | Who                      | What                                                                                             |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------ |
| Cloudflare account super admin | Evan (evan@voidzero.dev) | Full account access — Workers, D1, KV, R2, DNS, Analytics Engine, **token generation / refresh** |
| 1Password tokens vault         | Evan (evan@voidzero.dev) | API tokens, OAuth secrets, JWT secrets for all environments                                      |
| API admin panel                | Evan (evan@voidzero.dev) | `api.void.cloud/admin` — project management, user management, deploys                            |

## What We Deploy

Four Cloudflare Workers:

| Worker           | Package              | Purpose                                                                                                   |
| ---------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `void-ai-proxy`  | `packages/ai-proxy`  | AI inference proxy — holds the real `AI` binding, injects AI Gateway metadata for metering                |
| `void-api`       | `packages/api`       | Control Plane API + Admin Dashboard — OAuth, project CRUD, deploy pipeline, usage metering                |
| `void-dashboard` | `packages/dashboard` | User-facing dashboard — project management, deployments, usage                                            |
| `void-dispatch`  | `packages/dispatch`  | Edge router — routes `*.void.app` traffic to user workers (via Workers for Platforms) or R2 static assets |

## Environments

Two fully isolated environments. Each has its own CF resources (D1, KV, R2, dispatch namespace, analytics engine).

| Environment    | API URL                  | Dashboard                 | User Sites           | Trigger                      |
| -------------- | ------------------------ | ------------------------- | -------------------- | ---------------------------- |
| **Production** | `api.void.cloud`         | `dash.void.cloud`         | `*.void.app`         | Push to `prod` branch        |
| **Staging**    | `api.staging.void.cloud` | `dash.staging.void.cloud` | `*.staging.void.app` | Push to `main` branch (auto) |

## Cloudflare Resources

### Production

**API worker** (`void-api`):

| Resource           | Binding    | Name / ID                                           |
| ------------------ | ---------- | --------------------------------------------------- |
| D1 Database        | `DB`       | `void-api` (`f85c1d7d-7b41-4f85-88e5-ad37966825e7`) |
| R2 Bucket          | `ASSETS`   | `void-assets`                                       |
| KV Namespace       | `ROUTING`  | `9250c33f3db6494ebe8ad6272812c8c0`                  |
| Dispatch Namespace | `DISPATCH` | `void-users`                                        |
| Cron Trigger       | —          | `*/5 * * * *`                                       |

**Dispatch worker** (`void-dispatch`):

| Resource           | Binding     | Name / ID                                       |
| ------------------ | ----------- | ----------------------------------------------- |
| Dispatch Namespace | `DISPATCH`  | `void-users`                                    |
| R2 Bucket          | `ASSETS`    | `void-assets`                                   |
| KV Namespace       | `ROUTING`   | `9250c33f3db6494ebe8ad6272812c8c0`              |
| Analytics Engine   | `ANALYTICS` | `vite_cloud_requests`                           |
| Routes             | —           | `*.void.app/*`, `*.void.app` (zone: `void.app`) |

**AI proxy worker** (`void-ai-proxy`):

| Resource   | Binding | Name / ID                                                     |
| ---------- | ------- | ------------------------------------------------------------- |
| Workers AI | `AI`    | (account-level)                                               |
| AI Gateway | —       | `void` (shared, account-level)                                |
| Routes     | —       | `ai-proxy.void.app/*`, `ai-proxy.void.app` (zone: `void.app`) |

**Dashboard worker** (`void-dashboard`):

| Resource | Binding | Name / ID                    |
| -------- | ------- | ---------------------------- |
| Assets   | —       | `dist/client` (static files) |
| Routes   | —       | `dash.void.cloud`            |

No bindings — the dashboard talks to the API via HTTP (BFF pattern with server-side loaders).

All workers: `compatibility_date: 2026-02-12`, `compatibility_flags: ["nodejs_compat"]`, `observability: enabled`.

### Staging

Same resource types with `-staging` suffixes:

| Resource    | API                                                         | Dashboard                 | Dispatch                                     | AI Proxy                                                   |
| ----------- | ----------------------------------------------------------- | ------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| D1          | `void-api-staging` (`e78b32c1-497a-40ad-8f83-7049e139983e`) | —                         | —                                            | —                                                          |
| R2          | `void-assets-staging`                                       | —                         | `void-assets-staging`                        | —                                                          |
| KV          | `60240eecea804f39bf8b7395cd6c6b08`                          | —                         | `60240eecea804f39bf8b7395cd6c6b08`           | —                                                          |
| Dispatch NS | `void-users-staging`                                        | —                         | `void-users-staging`                         | —                                                          |
| Analytics   | —                                                           | —                         | `vite_cloud_requests_staging`                | —                                                          |
| Workers AI  | —                                                           | —                         | —                                            | `AI` (account-level)                                       |
| Routes      | —                                                           | `dash.staging.void.cloud` | `*.staging.void.app/*`, `*.staging.void.app` | `ai-proxy.staging.void.app/*`, `ai-proxy.staging.void.app` |

## Secrets and Environment Variables

All secrets are stored in a dedicated 1Password vault.

### API Worker Secrets

Set via `wrangler secret put <NAME>` (separate values per environment):

| Secret                 | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `CF_API_TOKEN`         | Cloudflare API token (see permissions below) |
| `CF_ACCOUNT_ID`        | Cloudflare account ID                        |
| `CF_ZONE_ID`           | DNS zone ID (`void.app` zone)                |
| `JWT_SECRET`           | Signs auth JWTs                              |
| `GITHUB_CLIENT_ID`     | GitHub OAuth app client ID                   |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret               |
| `GOOGLE_CLIENT_ID`     | Google OAuth app client ID                   |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app client secret               |

**API worker `CF_API_TOKEN` permissions** — this is the broad-scope token used at runtime to provision and manage user resources. Separate from the GitHub Actions deploy token.

Account-level:

| Permission         | Access | Operations                                             |
| ------------------ | ------ | ------------------------------------------------------ |
| Workers Scripts    | Edit   | Upload/delete user workers in dispatch namespace       |
| D1                 | Edit   | Create databases, execute migrations, delete databases |
| Workers KV Storage | Edit   | Create/delete KV namespaces                            |
| Workers R2 Storage | Edit   | Create/delete R2 buckets                               |
| Queues             | Edit   | Create/delete queues, manage queue consumers           |
| Account Analytics  | Read   | Query Analytics Engine SQL API for usage metering      |

Zone-level (on `void.app`):

| Permission           | Access | Operations                                  |
| -------------------- | ------ | ------------------------------------------- |
| SSL and Certificates | Edit   | Custom hostname DV certificate provisioning |

### AI Proxy Worker Secrets

Set via `wrangler secret put <NAME>` (same value as API worker's `JWT_SECRET`):

| Secret       | Purpose                                   |
| ------------ | ----------------------------------------- |
| `JWT_SECRET` | Verifies auth JWTs from local dev clients |

### Configurable Environment Variables

Set via `vars` in `wrangler.jsonc` (production uses defaults, staging overrides):

| Worker    | Variable             | Default                                | Staging Override                               | Purpose                                           |
| --------- | -------------------- | -------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| api       | `DISPATCH_NAMESPACE` | `void-users`                           | `void-users-staging`                           | CF dispatch namespace name                        |
| api       | `SITE_DOMAIN`        | `void.app`                             | `staging.void.app`                             | Base domain for deploy URL output                 |
| api       | `AUTH_REDIRECT_URI`  | `https://api.void.cloud/auth/callback` | `https://api.staging.void.cloud/auth/callback` | OAuth callback URL                                |
| api       | `SIGNUP_ALLOWLIST`   | (unset)                                | `@voidzero.dev`                                | Comma-separated emails/domains for new signups    |
| api       | `DEV_AUTH_BYPASS`    | (unset)                                | —                                              | Skip admin OAuth for local dev (`.dev.vars` only) |
| dashboard | `API_URL`            | (unset, defaults to production)        | `https://api.staging.void.cloud`               | API base URL for BFF server-side loaders          |
| dispatch  | `BASE_HOSTNAME`      | `void.app`                             | `staging.void.app`                             | Base hostname for slug extraction                 |

### GitHub Actions Secrets

Two GitHub environments (`Prod` and `Staging`) each hold the same secrets (values are **the same** for both environments, we only use one API token):

| Secret          | Purpose                                                   |
| --------------- | --------------------------------------------------------- |
| `CF_API_TOKEN`  | Cloudflare API token (see permissions below)              |
| `CF_ACCOUNT_ID` | Cloudflare account ID (passed as `CLOUDFLARE_ACCOUNT_ID`) |

`deploy.yml` (push to `prod`) uses the `Prod` environment; `deploy-staging.yml` (push to `main`) uses `Staging`.

**GitHub Actions `CF_API_TOKEN` permissions** — narrower-scope token used only for wrangler deploys. Separate from the API worker runtime token.

Account-level:

| Permission         | Access | Operations                                             |
| ------------------ | ------ | ------------------------------------------------------ |
| Workers Scripts    | Edit   | Deploy API and dispatch workers                        |
| D1                 | Edit   | Run remote migrations (`wrangler d1 migrations apply`) |
| Workers KV Storage | Edit   | Bind KV namespaces during deploy                       |
| Workers R2 Storage | Edit   | Bind R2 buckets during deploy                          |

Zone-level (on `void.app`):

| Permission     | Access | Operations                                          |
| -------------- | ------ | --------------------------------------------------- |
| Workers Routes | Edit   | Set dispatch worker route patterns (`*.void.app/*`) |
| DNS            | Read   | Zone lookup for route binding                       |

### CLI Staging Mode

Internal-only toggle for pointing the CLI at staging. Not documented in public docs.

- `void staging on` — sets `"staging": true` in `~/.void/config.json`
- Reads/writes `stagingToken` instead of `token`
- Defaults API URL to `https://api.staging.void.cloud`
- Can also be activated via `STAGING=1` env var or `VOID_API_URL` env var

## Deploy Process

### Deploy Scripts

Root `package.json` orchestrates deployment:

```
pnpm run deploy           # Production: deploy ai-proxy, dispatch, then migrate + deploy api
pnpm run deploy:staging   # Staging: same with --env staging
```

Broken down:

```
deploy
├── deploy:ai-proxy     → pnpm -F ai-proxy run deploy    (wrangler deploy)
├── deploy:dispatch     → pnpm -F dispatch run deploy     (wrangler deploy)
├── deploy:api          → pnpm -F api migrate             (wrangler d1 migrations apply --remote)
│                       → pnpm -F api run deploy          (wrangler deploy)
└── deploy:dashboard    → pnpm -F dashboard run deploy    (wrangler deploy)

deploy:staging
├── deploy:staging:ai-proxy  → pnpm -F ai-proxy run deploy --env staging
├── deploy:staging:dispatch  → pnpm -F dispatch run deploy --env staging
├── deploy:staging:api       → pnpm -F api migrate:staging  (wrangler d1 migrations apply --env staging --remote)
│                            → pnpm -F api run deploy --env staging
└── deploy:staging:dashboard → pnpm -F dashboard run deploy:staging
```

Deploy order matters: ai-proxy deploys first (user workers depend on it via service binding), dispatch deploys next (stateless router), then api runs D1 migrations before deploying (ensures schema is ready for new code), and dashboard deploys last.

### GitHub Actions

Three workflows in `.github/workflows/`:

**`ci.yml`** — runs on PRs to `main` and as a reusable workflow:

1. Install pnpm + Node.js (from `.node-version`)
2. `pnpm install --frozen-lockfile`
3. `pnpm -r build` (build all packages)
4. `pnpm lint` (oxlint)
5. `pnpm check` (typecheck all packages)
6. `pnpm test` (full test suite)

**`deploy.yml`** — runs on push to `prod` (production, environment: `Prod`):

1. Runs CI workflow first
2. `pnpm run deploy` (ai-proxy, dispatch, api, dashboard workers)

**`deploy-staging.yml`** — runs on push to `main` (staging, environment: `Staging`):

1. Runs CI workflow first
2. `pnpm run deploy:staging` (all workers to staging)

### Health Checks

```
pnpm health            # Check production API health
pnpm health:staging    # Check staging API health
```

## DNS Setup

| Record                      | Zone         | Points To                                |
| --------------------------- | ------------ | ---------------------------------------- |
| `api.void.cloud`            | `void.cloud` | API worker                               |
| `dash.void.cloud`           | `void.cloud` | Dashboard worker                         |
| `*.void.app`                | `void.app`   | Dispatch worker (wildcard route)         |
| `ai-proxy.void.app`         | `void.app`   | AI proxy worker                          |
| `api.staging.void.cloud`    | `void.cloud` | Staging API worker                       |
| `dash.staging.void.cloud`   | `void.cloud` | Staging dashboard worker                 |
| `*.staging.void.app`        | `void.app`   | Staging dispatch worker (wildcard route) |
| `ai-proxy.staging.void.app` | `void.app`   | Staging AI proxy worker                  |

## Fresh Environment Setup

Steps to provision a new environment from scratch (e.g. reproducing staging):

1. **Create CF resources** (all with environment suffix):
   - D1 database
   - KV namespace
   - R2 bucket
   - Dispatch namespace (Workers for Platforms)
   - Analytics Engine dataset
   - AI Gateway named `void`

2. **Update wrangler configs** — add an `env.<name>` section in `packages/api/wrangler.jsonc`, `packages/dashboard/wrangler.jsonc`, `packages/dispatch/wrangler.jsonc`, and `packages/ai-proxy/wrangler.jsonc` with the new resource IDs.

3. **Set worker secrets** — for the API worker:

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

4. **DNS records** — on the `void.app` zone, add a wildcard CNAME for user sites. On the `void.cloud` zone, add CNAMEs for the API and dashboard.

5. **OAuth callback URLs** — add the new API URL as an authorized redirect in both the GitHub OAuth App and Google OAuth Client:
   - `https://<api-host>/auth/callback`
   - `https://<api-host>/admin/callback`

6. **GitHub Actions** — if CI/CD should deploy to this environment, add a workflow file and configure GitHub environment secrets (`CF_API_TOKEN`, `CF_ACCOUNT_ID`).

7. **Deploy** — run `pnpm run deploy --env <name>` or equivalent.
