# Operations

How we deploy, what we provision, and how the system is configured.

## What We Deploy

Two Cloudflare Workers plus a static docs site:

| Worker                | Package             | Purpose                                                                                                        |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
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

Both workers: `compatibility_date: 2026-02-12`, `compatibility_flags: ["nodejs_compat"]`, `observability: enabled`.

### Staging

Same resource types with `-staging` suffixes:

| Resource    | Platform                                                               | Dispatch                                               |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| D1          | `vite-cloud-platform-staging` (`e78b32c1-497a-40ad-8f83-7049e139983e`) | —                                                      |
| R2          | `vite-cloud-assets-staging`                                            | `vite-cloud-assets-staging`                            |
| KV          | `60240eecea804f39bf8b7395cd6c6b08`                                     | `60240eecea804f39bf8b7395cd6c6b08`                     |
| Dispatch NS | `vite-cloud-users-staging`                                             | `vite-cloud-users-staging`                             |
| Analytics   | —                                                                      | `vite_cloud_requests_staging`                          |
| Routes      | —                                                                      | `*.staging.vitecloud.app/*`, `*.staging.vitecloud.app` |

## Secrets and Environment Variables

All secrets are stored in a dedicated 1Password vault.

### Platform Worker Secrets

Set via `wrangler secret put <NAME>` (separate values per environment):

| Secret                 | Purpose                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CF_API_TOKEN`         | Cloudflare API token for managing user workers, DNS, R2 (broad scope — separate token from GitHub Actions) |
| `CF_ACCOUNT_ID`        | Cloudflare account ID                                                                                      |
| `CF_ZONE_ID`           | DNS zone ID                                                                                                |
| `JWT_SECRET`           | Signs auth JWTs                                                                                            |
| `GITHUB_CLIENT_ID`     | GitHub OAuth app client ID                                                                                 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret                                                                             |
| `GOOGLE_CLIENT_ID`     | Google OAuth app client ID                                                                                 |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app client secret                                                                             |

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

| Secret             | Purpose                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `CF_API_TOKEN`     | Cloudflare API token scoped to wrangler deploys only (separate token from platform worker) |
| `CF_ACCOUNT_ID`    | Cloudflare account ID (passed as `CLOUDFLARE_ACCOUNT_ID`)                                  |
| `VITE_CLOUD_TOKEN` | Auth token for deploying docs via `vcc deploy`                                             |

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
pnpm run deploy           # Production: deploy dispatch, then migrate + deploy platform
pnpm run deploy:staging   # Staging: same with --env staging
```

Broken down:

```
deploy
├── deploy:dispatch         → pnpm -F dispatch run deploy          (wrangler deploy)
└── deploy:platform         → pnpm -F platform migrate             (wrangler d1 migrations apply --remote)
                            → pnpm -F platform run deploy          (wrangler deploy)

deploy:staging
├── deploy:staging:dispatch → pnpm -F dispatch run deploy --env staging
└── deploy:staging:platform → pnpm -F platform migrate:staging     (wrangler d1 migrations apply --env staging --remote)
                            → pnpm -F platform run deploy --env staging
```

Deploy order matters: dispatch deploys first (stateless router), then platform runs D1 migrations before deploying (ensures schema is ready for new code).

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

| Record                        | Zone            | Points To                                |
| ----------------------------- | --------------- | ---------------------------------------- |
| `platform.vite.cloud`         | `vite.cloud`    | Platform worker                          |
| `*.vitecloud.app`             | `vitecloud.app` | Dispatch worker (wildcard route)         |
| `platform.staging.vite.cloud` | `vite.cloud`    | Staging platform worker                  |
| `*.staging.vitecloud.app`     | `vitecloud.app` | Staging dispatch worker (wildcard route) |

## Fresh Environment Setup

Steps to provision a new environment from scratch (e.g. reproducing staging):

1. **Create CF resources** (all with environment suffix):
   - D1 database
   - KV namespace
   - R2 bucket
   - Dispatch namespace (Workers for Platforms)
   - Analytics Engine dataset

2. **Update wrangler configs** — add an `env.<name>` section in both `packages/platform/wrangler.jsonc` and `packages/dispatch/wrangler.jsonc` with the new resource IDs.

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
