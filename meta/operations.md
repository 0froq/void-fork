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

| Worker           | Package              | Purpose                                                                                                                   |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `void-proxy`     | `packages/proxy`     | Unified proxy — AI inference metering + D1/KV/R2 remote bindings for local dev                                            |
| `void-api`       | `packages/api`       | Control Plane API + Admin Dashboard — OAuth, project CRUD, deploy pipeline, usage metering                                |
| `void-dashboard` | `packages/dashboard` | User-facing dashboard — project management, deployments, usage                                                            |
| `void-tail`      | `packages/tail`      | Tail worker — captures user worker logs to Analytics Engine + live tailing via Durable Object WebSockets                  |
| `void-dispatch`  | `packages/dispatch`  | Edge router — routes `*.void.app` + custom domain traffic to user workers (via Workers for Platforms) or R2 static assets |

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
| R2 Bucket          | `ASSETS`        | `void-assets`                                                 |
| KV Namespace       | `ROUTING`       | `9250c33f3db6494ebe8ad6272812c8c0`                            |
| Dispatch Namespace | `DISPATCH`      | `void-users`                                                  |
| Durable Object     | `USAGE_COUNTER` | `UsageCounter` (per-user usage enforcement)                   |
| Queue (consumer)   | —               | `void-usage-events` (batch 100, timeout 5s)                   |
| Cron Trigger       | —               | `0 * * * *` (hourly — billing rollovers + backfill)           |

**Dispatch worker** (`void-dispatch`):

| Resource           | Binding       | Name / ID                                                   |
| ------------------ | ------------- | ----------------------------------------------------------- |
| Dispatch Namespace | `DISPATCH`    | `void-users`                                                |
| R2 Bucket          | `ASSETS`      | `void-assets`                                               |
| KV Namespace       | `ROUTING`     | `9250c33f3db6494ebe8ad6272812c8c0`                          |
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
| R2          | `void-assets-staging`                                         | —                                                             | `void-assets-staging`                                    | —                                                        |
| KV          | `60240eecea804f39bf8b7395cd6c6b08`                            | —                                                             | `60240eecea804f39bf8b7395cd6c6b08`                       | —                                                        |
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

| Secret                 | Environment | Purpose                                                         |
| ---------------------- | ----------- | --------------------------------------------------------------- |
| `CF_API_TOKEN`         | Both        | Cloudflare API token (see permissions below)                    |
| `CF_ACCOUNT_ID`        | Both        | Cloudflare account ID (passed as `CLOUDFLARE_ACCOUNT_ID`)       |
| `DATABASE_URL`         | Prod        | PlanetScale direct connection string for drizzle-kit migrations |
| `STAGING_DATABASE_URL` | Staging     | PlanetScale direct connection string for drizzle-kit migrations |

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
- Can also be activated via `STAGING=1` env var or `VOID_API_URL` env var

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
   - KV namespace
   - R2 bucket
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
