# Operations

How we deploy, what we provision, and how the system is configured.

## Access Levels

| System                         | Who                      | What                                                                                                     |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Cloudflare account super admin | Evan (evan@voidzero.dev) | Full account access — Workers, KV, R2, DNS, Analytics Engine, Hyperdrive, **token generation / refresh** |
| PlanetScale                    | Evan (evan@voidzero.dev) | PostgreSQL database — platform DB (branches, connection strings, dashboard)                              |
| 1Password tokens vault         | Evan (evan@voidzero.dev) | API tokens, OAuth secrets, JWT secrets for all environments                                              |
| API admin panel                | Evan (evan@voidzero.dev) | `api.void.cloud/admin` — project management, user management, deploys                                    |

## What We Deploy

Five Cloudflare Workers:

| Worker           | Package              | Purpose                                                                                                                             |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `void-proxy`     | `packages/proxy`     | Unified proxy — AI inference metering + D1/KV/R2 remote bindings for local dev                                                      |
| `void-api`       | `packages/api`       | Control Plane API + Admin Dashboard — OAuth, project CRUD, deploy pipeline, usage metering                                          |
| `void-dashboard` | `packages/dashboard` | User-facing dashboard — project management, deployments, usage                                                                      |
| `void-tail`      | `packages/tail`      | Tail worker — captures user worker logs to Analytics Engine + live tailing via Durable Object WebSockets                            |
| `void-dispatch`  | `packages/dispatch`  | Edge router — routes `*.void.app` + custom domain traffic to user workers (via Workers for Platforms), static assets, and ISR cache |

## Environments

Two fully isolated environments. Each has its own CF resources (KV, R2, dispatch namespace, analytics engine) and a separate Hyperdrive configuration pointing to its own PlanetScale PostgreSQL database.

| Environment    | API URL                  | Dashboard                 | User Sites           | Trigger                      |
| -------------- | ------------------------ | ------------------------- | -------------------- | ---------------------------- |
| **Production** | `api.void.cloud`         | `dash.void.cloud`         | `*.void.app`         | Push to `prod` branch        |
| **Staging**    | `api.staging.void.cloud` | `dash.staging.void.cloud` | `*.staging.void.app` | Push to `main` branch (auto) |

## Cloudflare Resources

### Production

**API worker** (`void-api`):

| Resource           | Binding         | Name / ID                                                     |
| ------------------ | --------------- | ------------------------------------------------------------- |
| Hyperdrive         | `HYPERDRIVE`    | `7bd6b2a606a347819ad3421867840736` (→ PlanetScale PostgreSQL) |
| KV Namespace       | `ROUTING`       | `9250c33f3db6494ebe8ad6272812c8c0`                            |
| KV Namespace       | `ISR_CACHE`     | `7a0284b2390b42218901919579aadf0e`                            |
| Dispatch Namespace | `DISPATCH`      | `void-users`                                                  |
| Durable Object     | `USAGE_COUNTER` | `UsageCounter` (per-user usage enforcement)                   |
| Queue (consumer)   | —               | `void-usage-events` (batch 100, timeout 5s)                   |
| Cron Trigger       | —               | `0 * * * *` (hourly — billing rollovers + backfill)           |

**Dispatch worker** (`void-dispatch`):

| Resource           | Binding       | Name / ID                                                   |
| ------------------ | ------------- | ----------------------------------------------------------- |
| Dispatch Namespace | `DISPATCH`    | `void-users`                                                |
| KV Namespace       | `ROUTING`     | `9250c33f3db6494ebe8ad6272812c8c0`                          |
| KV Namespace       | `ISR_CACHE`   | `7a0284b2390b42218901919579aadf0e`                          |
| Analytics Engine   | `ANALYTICS`   | `vite_cloud_requests`                                       |
| Queue (producer)   | `USAGE_QUEUE` | `void-usage-events`                                         |
| Routes             | —             | `*.void.app/*`, `*.void.app`, `*/*`, `*` (zone: `void.app`) |

**Tail worker** (`void-tail`):

| Resource         | Binding      | Name / ID                                   |
| ---------------- | ------------ | ------------------------------------------- |
| Analytics Engine | `ANALYTICS`  | `void_logs`                                 |
| Durable Object   | `LOG_STREAM` | `LogStream` (per-worker live log broadcast) |

**Proxy worker** (`void-proxy`):

| Resource        | Binding | Name / ID                                                     |
| --------------- | ------- | ------------------------------------------------------------- |
| Workers AI      | `AI`    | (account-level)                                               |
| AI Gateway      | —       | `void` (shared, account-level)                                |
| Service Binding | `API`   | `void-api` (for internal revalidation)                        |
| Routes          | —       | `proxy.void.cloud/*`, `proxy.void.cloud` (zone: `void.cloud`) |

**Dashboard worker** (`void-dashboard`):

| Resource   | Binding      | Name / ID                                                     |
| ---------- | ------------ | ------------------------------------------------------------- |
| Hyperdrive | `HYPERDRIVE` | `7bd6b2a606a347819ad3421867840736` (→ PlanetScale PostgreSQL) |
| Service    | `API`        | `void-api`                                                    |
| Assets     | —            | `dist/client` (static files)                                  |
| Routes     | —            | `dash.void.cloud`                                             |

The dashboard has a Hyperdrive binding for read-only loaders (direct Drizzle queries) and a service binding to the API worker for mutations.

All workers: `compatibility_date: 2026-02-12`, `compatibility_flags: ["nodejs_compat"]`, `observability: enabled`.

### Staging

Same resource types with `-staging` suffixes:

| Resource    | API                                                           | Dashboard                                                     | Dispatch                                                 | Proxy                                                    |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Hyperdrive  | `7cde35825e6249d0b60b9de69feb29dd` (→ PlanetScale PostgreSQL) | `7cde35825e6249d0b60b9de69feb29dd` (→ PlanetScale PostgreSQL) | —                                                        | —                                                        |
| KV ROUTING  | `60240eecea804f39bf8b7395cd6c6b08`                            | —                                                             | `60240eecea804f39bf8b7395cd6c6b08`                       | —                                                        |
| KV ISR      | `7f13ef3a3745445c883a5bbc72f031b7`                            | —                                                             | `7f13ef3a3745445c883a5bbc72f031b7`                       | —                                                        |
| Dispatch NS | `void-users-staging`                                          | —                                                             | `void-users-staging`                                     | —                                                        |
| Analytics   | —                                                             | —                                                             | `vite_cloud_requests_staging`                            | —                                                        |
| Queue       | `void-usage-events-staging` (consumer)                        | —                                                             | `void-usage-events-staging` (producer)                   | —                                                        |
| DO          | `UsageCounter` (same class, staging-isolated)                 | —                                                             | —                                                        | —                                                        |
| Workers AI  | —                                                             | —                                                             | —                                                        | `AI` (account-level)                                     |
| Service     | —                                                             | `void-api-staging`                                            | —                                                        | `void-api-staging` (API binding)                         |
| Routes      | —                                                             | `dash.staging.void.cloud`                                     | `*.staging.void.app/*`, `*.staging.void.app`, `*/*`, `*` | `proxy.staging.void.cloud/*`, `proxy.staging.void.cloud` |

## Secrets and Environment Variables

All secrets are stored in a dedicated 1Password vault.

### API Worker Secrets

Set via `wrangler secret put <NAME>` (separate values per environment):

| Secret                              | Purpose                                          |
| ----------------------------------- | ------------------------------------------------ |
| `CF_API_TOKEN`                      | Cloudflare API token (see permissions below)     |
| `CF_ACCOUNT_ID`                     | Cloudflare account ID                            |
| `CF_ZONE_ID`                        | DNS zone ID (`void.app` zone)                    |
| `JWT_SECRET`                        | Signs auth JWTs                                  |
| `PROJECT_SECRET_KEYS_JSON`          | JSON keyring for encrypted project secrets       |
| `PROJECT_SECRET_ACTIVE_KEY_VERSION` | Active key version for new project-secret writes |
| `GITHUB_CLIENT_ID`                  | GitHub OAuth app client ID                       |
| `GITHUB_CLIENT_SECRET`              | GitHub OAuth app client secret                   |
| `GOOGLE_CLIENT_ID`                  | Google OAuth app client ID                       |
| `GOOGLE_CLIENT_SECRET`              | Google OAuth app client secret                   |

`PROJECT_SECRET_KEYS_JSON` should be a JSON object mapping key-version strings to base64-encoded 32-byte AES keys. `PROJECT_SECRET_ACTIVE_KEY_VERSION` must match one of those configured versions.

Example:

```json
{ "1": "<base64-32-byte-key>" }
```

With:

```text
PROJECT_SECRET_ACTIVE_KEY_VERSION=1
```

Generate a new 32-byte key with:

```bash
openssl rand -base64 32
```

**API worker `CF_API_TOKEN` permissions** — this is the broad-scope token used at runtime to provision and manage user resources. Separate from the GitHub Actions deploy token.

Account-level:

| Permission         | Access | Operations                                                       |
| ------------------ | ------ | ---------------------------------------------------------------- |
| Workers Scripts    | Edit   | Upload/delete user workers in dispatch namespace                 |
| Workers Tail       | Read   | Create/delete tail sessions for live log streaming               |
| D1                 | Edit   | Create/delete user project D1 databases, execute user migrations |
| Workers KV Storage | Edit   | Create/delete KV namespaces                                      |
| Workers R2 Storage | Edit   | Create/delete R2 buckets                                         |
| Queues             | Edit   | Create/delete queues, manage queue consumers                     |
| Account Analytics  | Read   | Query Analytics Engine SQL API for usage metering                |

Zone-level (on `void.app`):

| Permission           | Access | Operations                                  |
| -------------------- | ------ | ------------------------------------------- |
| SSL and Certificates | Edit   | Custom hostname DV certificate provisioning |

### Proxy Worker Secrets

Set via `wrangler secret put <NAME>`:

| Secret          | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `JWT_SECRET`    | Verifies auth JWTs from local dev clients (same as API worker) |
| `CF_ACCOUNT_ID` | Cloudflare account ID (for D1/KV/R2 REST API calls)            |
| `CF_API_TOKEN`  | Cloudflare API token (for D1/KV/R2 REST API calls)             |

### Configurable Environment Variables

Set via `vars` in `wrangler.jsonc` (production uses defaults, staging overrides):

| Worker    | Variable             | Default                                | Staging Override                               | Purpose                                           |
| --------- | -------------------- | -------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| api       | `DISPATCH_NAMESPACE` | `void-users`                           | `void-users-staging`                           | CF dispatch namespace name                        |
| api       | `VOID_PROXY_SERVICE` | `void-proxy`                           | `void-proxy-staging`                           | Proxy worker name for service binding injection   |
| api       | `SITE_DOMAIN`        | `void.app`                             | `staging.void.app`                             | Base domain for deploy URL output                 |
| api       | `AUTH_REDIRECT_URI`  | `https://api.void.cloud/auth/callback` | `https://api.staging.void.cloud/auth/callback` | OAuth callback URL                                |
| api       | `DEV_AUTH_BYPASS`    | (unset)                                | —                                              | Skip admin OAuth for local dev (`.dev.vars` only) |
| dashboard | `API_URL`            | (unset, defaults to production)        | `https://api.staging.void.cloud`               | API base URL for BFF server-side loaders          |
| dispatch  | `BASE_HOSTNAME`      | `void.app`                             | `staging.void.app`                             | Base hostname for slug extraction                 |

### GitHub Actions Secrets

Two GitHub environments (`Prod` and `Staging`) share the same repo-level secrets plus environment-specific database URLs:

| Secret                            | Environment | Purpose                                                                             |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `CF_API_TOKEN`                    | Both        | Cloudflare API token (see permissions below)                                        |
| `CF_ACCOUNT_ID`                   | Both        | Cloudflare account ID (passed as `CLOUDFLARE_ACCOUNT_ID`)                           |
| `DATABASE_URL`                    | Prod        | PlanetScale direct connection string for drizzle-kit migrations                     |
| `STAGING_DATABASE_URL`            | Staging     | PlanetScale direct connection string for drizzle-kit migrations                     |
| `CF_ACCESS_CLIENT_ID_STAGING`     | Staging     | CF Access service-token client id for reaching staging (see Staging Access Control) |
| `CF_ACCESS_CLIENT_SECRET_STAGING` | Staging     | CF Access service-token client secret for reaching staging                          |

`deploy.yml` (push to `prod`) uses the `Prod` environment; `deploy-staging.yml` (push to `main`) uses `Staging`.

**GitHub Actions `CF_API_TOKEN` permissions** — narrower-scope token used only for wrangler deploys. Separate from the API worker runtime token.

Account-level:

| Permission         | Access | Operations                                   |
| ------------------ | ------ | -------------------------------------------- |
| Workers Scripts    | Edit   | Deploy API and dispatch workers              |
| D1                 | Edit   | Bind user project D1 databases during deploy |
| Workers KV Storage | Edit   | Bind KV namespaces during deploy             |
| Workers R2 Storage | Edit   | Bind R2 buckets during deploy                |

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
- Can also be activated via `VOID_API_URL=https://api.staging.void.cloud`. The CLI does **not** read `STAGING=1` (`framework/packages/void/src/cli/project.ts:isVoidInternalStaging` only checks `.void/project.json`), so CI workflows must set `VOID_API_URL` explicitly.

## Staging Access Control

All four public staging hostnames sit behind Cloudflare Access:

- `api.staging.void.cloud`
- `dash.staging.void.cloud`
- `proxy.staging.void.cloud`
- `*.staging.void.app` (wildcard over dispatch)

Production hostnames are **not** gated — this applies to staging only, even though staging and prod share the same CF account.

**Identity policy:** each of the four Access Applications has one `Allow` rule: `GitHub organization = voidzero-dev` via GitHub as the IdP. Log into CF Zero Trust with any GitHub account that is a member of the `voidzero-dev` GitHub organization to pass. Email-based matching is avoided because GitHub does not reliably expose a primary email unless the user has made it public. Members whose org membership is private must click **Grant** on the OAuth consent screen the first time they sign in; if the org ever enforces SAML SSO, each member must also SSO-authorize the CF Access OAuth app via `github.com/orgs/voidzero-dev/sso`.

**Bypass rules** (do not prompt for Access login — paths hit by third-party OAuth redirects):

- `api.staging.void.cloud/auth/callback`
- `api.staging.void.cloud/admin/callback`
- `dash.staging.void.cloud/auth/callback`

Each path is self-validating in application code via HMAC-signed `state` and nonce cookies, so bypassing Access does not weaken auth.

### Teammate dev setup (browser-based, no shared secret)

The Void CLI auto-authenticates against staging via `cloudflared`. One-time setup per machine:

```
brew install cloudflared
```

That's it. The first time you run any `void` command against staging (`void project status`, `void deploy`, etc.), the CLI shells out to `cloudflared access login` if no cached JWT exists — a browser tab opens, you sign in with GitHub (must be a `voidzero-dev` org member), and a 24-hour JWT lands in the local cloudflared cache. Subsequent runs within 24h are silent.

No env vars, no 1Password dance, no shared secret. The JWT is tied to your GitHub identity — revoked the moment you leave the org.

Manual `cloudflared` commands if you need to force re-auth or inspect the token:

```
cloudflared access login https://api.staging.void.cloud
cloudflared access token -app=https://api.staging.void.cloud   # prints the cached JWT
```

### Service token (CI / non-interactive)

For CI and any non-interactive automation, a shared service token `void-staging-programmatic` (CF Zero Trust → Access → Service Auth) is stored in 1Password under `void / staging / cf-access-service-token` and duplicated into the `Staging` GitHub environment as `CF_ACCESS_CLIENT_ID_STAGING` and `CF_ACCESS_CLIENT_SECRET_STAGING`.

The framework's `cfAccessHeaders` helper resolves credentials in this priority order:

1. **Service token pair** — `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` → sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` (CI path)
2. **User JWT** — `CF_ACCESS_TOKEN` → sends `cf-access-token` (dev path, usually populated by the CLI's `cloudflared` probe)
3. **None** — no headers (prod, or unprotected hostnames)

Callers:

| Caller                                   | How credentials are resolved                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Void CLI (`void deploy`, `void whoami`…) | Eager `cloudflared` probe at client construction → sets `CF_ACCESS_TOKEN`. `CF_ACCESS_CLIENT_ID`/`SECRET` in env override the probe.                                      |
| Smoke-test CI workflow                   | `.github/workflows/smoke-test.yml` → `$CF_ACCESS_CLIENT_ID_STAGING` / `$CF_ACCESS_CLIENT_SECRET_STAGING` (service token)                                                  |
| Remote D1/KV/R2 bindings in local dev    | Whatever env vars the local process inherits; CLI's `CF_ACCESS_TOKEN` is forwarded to miniflare                                                                           |
| Deployed staging user workers            | `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` set as worker env bindings (rare — only if the worker calls `proxy.staging.void.cloud` directly via `__VOID_PROXY_URL`) |

**Rotating the service token:** rotate in the CF Zero Trust dashboard, update the 1Password entry and both `Staging` GitHub secrets, and notify anyone with the creds set in their shell. No code change required. Teammate JWTs (via `cloudflared`) are per-user and unaffected.

**Rollback:** delete the four Access Applications in CF Zero Trust. Code changes are inert when neither credential path is populated, so no code rollback needed.

## Deploy Process

### Deploy Scripts

Root `package.json` orchestrates deployment:

```
pnpm run deploy           # Production: deploy proxy, then migrate (drizzle-kit) + deploy api, then dispatch
pnpm run deploy:staging   # Staging: same with --env staging
```

Broken down:

```
deploy
├── deploy:proxy        → pnpm -F proxy run deploy        (wrangler deploy)
├── deploy:api          → pnpm -F api migrate             (drizzle-kit migrate — requires DATABASE_URL)
│                       → pnpm -F api run deploy          (wrangler deploy)
└── deploy:dispatch     → pnpm -F dispatch run deploy     (wrangler deploy)

deploy:staging
├── deploy:staging:proxy     → pnpm -F proxy run deploy --env staging
├── deploy:staging:api       → pnpm -F api migrate:staging  (DATABASE_URL=$STAGING_DATABASE_URL drizzle-kit migrate)
│                            → pnpm -F api run deploy --env staging
└── deploy:staging:dispatch  → pnpm -F dispatch run deploy --env staging
```

Deploy order matters: proxy deploys first (user workers depend on it via service binding), then api runs PostgreSQL migrations via drizzle-kit before deploying (ensures schema is ready for new code), and dispatch deploys last. Dashboard is deployed separately (not included in `deploy` / `deploy:staging` scripts).

### API rollout notes for DB-backed project secrets

When rolling out the API version that introduces encrypted DB-backed project secrets:

1. set `PROJECT_SECRET_KEYS_JSON` and `PROJECT_SECRET_ACTIVE_KEY_VERSION` on the API worker before deploy
2. run the normal API migrate-then-deploy flow (`pnpm deploy:api` or `pnpm deploy:staging:api`)
3. roll out the framework/runtime side after the API is live

The API migration creates the `project_secrets` table. The deploy scripts above already run the migration before `wrangler deploy`.

This is a clean cutover. The API only reads project secrets from `project_secrets`; any older worker-only secrets set directly on Cloudflare workers are ignored after rollout. If there are existing staging/test projects with secrets you still need, re-add them with `void secret put` or `void secret sync` after the API deploy.

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
2. `pnpm run deploy` (proxy, api with drizzle-kit migrations, dispatch)

**`deploy-staging.yml`** — runs on push to `main` (staging, environment: `Staging`):

1. Runs CI workflow first
2. `pnpm run deploy:staging` (proxy, api with drizzle-kit migrations, dispatch — all to staging)

### Health Checks

```
pnpm health            # Check production API health
pnpm health:staging    # Check staging API health
```

## DNS Setup

| Record                     | Zone         | Points To                                  |
| -------------------------- | ------------ | ------------------------------------------ |
| `api.void.cloud`           | `void.cloud` | API worker                                 |
| `dash.void.cloud`          | `void.cloud` | Dashboard worker                           |
| `*.void.app`               | `void.app`   | Dispatch worker (wildcard route)           |
| `cname.void.app`           | `void.app`   | CF for SaaS fallback origin (AAAA `100::`) |
| `proxy.void.cloud`         | `void.cloud` | Proxy worker                               |
| `api.staging.void.cloud`   | `void.cloud` | Staging API worker                         |
| `dash.staging.void.cloud`  | `void.cloud` | Staging dashboard worker                   |
| `*.staging.void.app`       | `void.app`   | Staging dispatch worker (wildcard route)   |
| `proxy.staging.void.cloud` | `void.cloud` | Staging proxy worker                       |

## Fresh Environment Setup

Steps to provision a new environment from scratch (e.g. reproducing staging):

1. **Provision PlanetScale database**:
   - Create a new database (or branch) in PlanetScale
   - Note the direct connection string (for drizzle-kit migrations) and the PgBouncer connection string (for Hyperdrive)
   - Run `DATABASE_URL=<direct-url> drizzle-kit migrate` from `packages/api/` to apply the schema

2. **Create CF resources** (all with environment suffix):
   - Hyperdrive configuration (pointing to the PlanetScale PgBouncer URL)
   - KV namespace for ROUTING
   - KV namespace for ISR_CACHE (`wrangler kv namespace create void-isr-cache-<env>`)
   - Dispatch namespace (Workers for Platforms)
   - Analytics Engine dataset
   - AI Gateway named `void`
   - Queue: `wrangler queues create void-usage-events-<env>` (usage enforcement events)

3. **Update wrangler configs** — add an `env.<name>` section in `packages/api/wrangler.jsonc`, `packages/dashboard/wrangler.jsonc`, `packages/dispatch/wrangler.jsonc`, and `packages/proxy/wrangler.jsonc` with the new resource IDs (including the Hyperdrive configuration ID).

4. **Set worker secrets** — for the API worker:

   ```
   wrangler secret put CF_API_TOKEN --env <name>
   wrangler secret put CF_ACCOUNT_ID --env <name>
   wrangler secret put CF_ZONE_ID --env <name>
   wrangler secret put JWT_SECRET --env <name>
   wrangler secret put PROJECT_SECRET_KEYS_JSON --env <name>
   wrangler secret put PROJECT_SECRET_ACTIVE_KEY_VERSION --env <name>
   wrangler secret put GITHUB_CLIENT_ID --env <name>
   wrangler secret put GITHUB_CLIENT_SECRET --env <name>
   wrangler secret put GOOGLE_CLIENT_ID --env <name>
   wrangler secret put GOOGLE_CLIENT_SECRET --env <name>

   ```

5. **DNS records** — all records must be proxied (orange cloud).

   **`void.app` zone:**

   | Record    | Type  | Content                                    | Purpose                                                       |
   | --------- | ----- | ------------------------------------------ | ------------------------------------------------------------- |
   | `cname`   | AAAA  | `100::`                                    | CF for SaaS fallback origin + CNAME target for custom domains |
   | `*.<env>` | CNAME | `void-dispatch-<env>.voidzer0.workers.dev` | Wildcard for dispatch worker route patterns                   |

   **`void.cloud` zone:**

   | Record        | Type  | Content                                 | Purpose            |
   | ------------- | ----- | --------------------------------------- | ------------------ |
   | `proxy.<env>` | CNAME | `void-proxy-<env>.voidzer0.workers.dev` | Proxy worker route |

   **Advanced Certificate Manager (ACM):** Each environment's wildcard subdomain needs an edge certificate. In the `void.app` zone, go to SSL/TLS > Edge Certificates > Advanced Certificate Manager and create a certificate covering `*.<env>.void.app`. Without this, HTTPS requests to `*.<env>.void.app` will fail even if DNS resolves correctly.

   **CF for SaaS (Custom Hostnames):** Enabled on the `void.app` zone. Fallback origin set to `cname.void.app`. The dispatch worker's `*/*` catch-all route intercepts custom hostname traffic before CF reaches the dummy `100::` origin. Users CNAME their custom domain to `cname.void.app`.

   **`void.cloud` zone** (API and dashboard use Worker Custom Domains — CF creates the DNS records automatically when you add the custom domain to the worker):

   | Record       | Type  | Content           | Purpose          |
   | ------------ | ----- | ----------------- | ---------------- |
   | `api.<env>`  | CNAME | _(managed by CF)_ | API worker       |
   | `dash.<env>` | CNAME | _(managed by CF)_ | Dashboard worker |

6. **OAuth callback URLs** — add the new API URL as an authorized redirect in both the GitHub OAuth App and Google OAuth Client:
   - `https://<api-host>/auth/callback`
   - `https://<api-host>/admin/callback`

7. **GitHub Actions** — if CI/CD should deploy to this environment, add a workflow file and configure GitHub environment secrets (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `DATABASE_URL` or `STAGING_DATABASE_URL` for drizzle-kit migrations).

8. **Deploy** — run `pnpm run deploy --env <name>` or equivalent.

## Signup Allowlist (Private Beta)

Temporary mechanism to restrict signups during private beta. Managed via the admin dashboard at `/admin/signup-control`.

**Storage:** Two keys in the existing `ROUTING` KV namespace (shared by API and dispatch workers):

| Key                | Value                                                        | Default   |
| ------------------ | ------------------------------------------------------------ | --------- |
| `signup:enabled`   | `"true"` or `"false"` — global toggle for signup restriction | `"false"` |
| `signup:allowlist` | JSON array of `{ type, pattern, note? }` entries             | `[]`      |

**Entry types:**

| Type     | Pattern examples    | Matches                                           |
| -------- | ------------------- | ------------------------------------------------- |
| `github` | `octocat`           | GitHub username (case-insensitive)                |
| `email`  | `alice@example.com` | Exact email address (case-insensitive)            |
| `email`  | `*@voidzero.dev`    | All emails at domain (wildcard, case-insensitive) |

**Behavior:** When `signup:enabled` is `"true"`, new user signups are checked against the allowlist. GitHub signups match against `github` entries by username. Google signups match against `email` entries. If no entry matches, the user is redirected to `/signup-restricted` (a static page saying "Sorry, we are still in private beta. Check back later!"). Existing users are never blocked — the check only applies to new account creation.

**Admin UI:** Toggle on/off, add/remove entries at `/admin/signup-control` (requires admin role).

**Cleanup (post-beta):** Delete KV keys `signup:enabled` and `signup:allowlist`, then remove the admin route (`src/admin/routes/signup-control.tsx`), view (`src/admin/views/signup-control.tsx`), matching logic (`src/signup-allowlist.ts`), the auth check in `src/routes/auth.ts`, the `/signup-restricted` route in `src/index.ts`, and the nav link in `src/admin/views/layout.tsx`.

## Migration History

### Platform DB: D1 → PlanetScale PostgreSQL (February 2026)

The platform's own database was migrated from Cloudflare D1 (SQLite) to PlanetScale PostgreSQL accessed via Cloudflare Hyperdrive. See `meta/design-docs/0015-platform-d1-to-planetscale.md` for the full design doc.

**What changed:**

| Component         | Before                                  | After                                                       |
| ----------------- | --------------------------------------- | ----------------------------------------------------------- |
| Database          | Cloudflare D1 (SQLite)                  | PlanetScale PostgreSQL via Hyperdrive                       |
| Driver            | `drizzle-orm/d1`                        | `drizzle-orm/node-postgres` (`pg` package)                  |
| Schema definition | `sqliteTable`                           | `pgTable`                                                   |
| Date columns      | `text` + `sql\`datetime('now')\``       | `timestamp` + `defaultNow()`                                |
| Wrangler binding  | `d1_databases` → `env.DB: D1Database`   | `hyperdrive` → `env.HYPERDRIVE: Hyperdrive`                 |
| Drizzle config    | `dialect: "sqlite"`                     | `dialect: "postgresql"`, `DATABASE_URL` env var             |
| Migrations        | `wrangler d1 migrations apply --remote` | `drizzle-kit migrate` (direct PlanetScale connection)       |
| Tests             | Miniflare D1                            | PGlite (in-process WASM PostgreSQL, `@electric-sql/pglite`) |

**What did NOT change:** User project D1 databases are still provisioned via the CF API — only the platform's own database uses PostgreSQL. The API worker's `CF_API_TOKEN` still needs D1 Edit permission for user project databases.

**Both API and Dashboard workers** share the same Hyperdrive configuration per environment, connecting to the same PlanetScale database. The dashboard uses direct Drizzle queries for read-only loaders; mutations go through the API worker.

### Domain: voidcloud.dev → void.app (February 2026)

The userspace domain was migrated from `voidcloud.dev` to `void.app` in February 2026. All DNS records, CF for SaaS configuration, API token permissions, code references, tests, and documentation have been updated. The `void.app` zone is now the primary zone for user site routing and custom domain CNAME targets (`cname.void.app`).

## Runbooks

### Pre-PR-#0067 sandbox cutover (one-time)

The 4 tenants below have stale CF container apps bound to per-deploy DO namespaces from before the cross-script DO host architecture (PR #131). Their next deploy after #131 ships will fail with:

> container application "proj-<id>-void-sandbox" exists but is bound to namespace ... (expected ...). This is the pre-PR-#0067 stuck-tenant state. Operator action required: ...

**Affected tenants (project IDs):**

- recappi (look up project ID before running)
- dtnyzh0qckg3
- 2ves8mgqb4po
- 60c3lfqptd2i

**Operator steps (run BEFORE the tenant's next deploy):**

1. Notify the tenant 24h in advance — sandbox container state will be lost (filesystem, processes, exposed ports, in-flight WebSockets).
2. Find each project's deterministic container app name: `proj-{projectId}-void-sandbox` (lowercased, underscores → dashes; same as `sandboxContainerApplicationName(projectId, 'void-sandbox')` in code).
3. Delete the stale container app:
   ```
   wrangler containers delete proj-<projectId>-void-sandbox
   ```
4. Tell the tenant they can deploy. Their first post-cutover deploy will:
   - PUT a fresh `do-host-${slug}` script
   - POST a fresh container app on the host's namespace
   - Resolve `getSandbox(id)` to a fresh DO instance (state lost — by design at cutover only)

Subsequent deploys preserve sandbox state per the architecture's normal guarantees.

### Sandbox host script orphaned after partial teardown failure

**Symptom:** A project was deleted but its `do-host-<slug>` script and/or `<projectId>-<containerName>` container application still exist in Cloudflare. This can happen if the platform's `teardownProject` flow crashed between status flip and CF cleanup completion, or after a manual operator intervention.

**Diagnosis:**

1. Confirm the project is fully deleted from PostgreSQL: `SELECT * FROM projects WHERE slug = '<slug>'` returns 0 rows.
2. List the dispatch namespace: `wrangler dispatch-namespace get-script <namespace> do-host-<slug>` — if it returns success, the host is orphaned.
3. List container apps: `wrangler containers list | rg <projectId>` — if any match, they're orphaned.

**Remediation:**

1. DELETE the host script: `curl -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/dispatch/namespaces/$DISPATCH_NAMESPACE/scripts/do-host-<slug>"`
2. DELETE the container app: `curl -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/containers/applications/<containerAppId>"`
3. Re-run platform teardown if the project row still exists in PG (idempotent).

**Why this can happen:** Critical CF DELETE failures (5xx, network) abort `teardownProject` BEFORE the DB cascade runs, so the operator can retry. But if the operator force-cascades the DB or runs an out-of-band delete, the CF state is left behind with no DB pointer.
