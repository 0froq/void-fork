# @voidcloud/api

Control-plane API and internal admin UI for Void.

It owns platform auth, projects, deployments, domains, secrets, provisioning, rollback, and usage/account enforcement. The worker uses Hono plus Drizzle over PostgreSQL via Hyperdrive.

## Architecture

- **Platform DB**: PostgreSQL via `HYPERDRIVE.connectionString`
- **Public API**: CLI and dashboard-facing JSON routes
- **Internal API**: resource resolution and revalidation used by other platform workers
- **Admin UI**: server-rendered HTML under `/admin/*`
- **Background work**:
  - `scheduled()` for periodic usage enforcement and rollover checks
  - `queue()` for usage-event ingestion

## Source Layout

```text
src/
  index.ts                    # Hono app, Drizzle setup, scheduled(), queue()
  env.ts                      # Worker env types
  schema.ts                   # Drizzle schema
  db.ts                       # Query layer
  types.ts                    # Shared types including DeployManifest
  assets.ts                   # Static asset upload/session helpers
  routing.ts                  # Routing KV updates
  cf-api.ts                   # Cloudflare API helpers
  cron-scheduler.ts           # Durable Object for project crons
  usage-counter.ts            # Durable Object for per-user usage counters
  usage-queue.ts              # Queue consumer logic
  tiers.ts                    # Plan limits + helpers
  provisioning/               # Worker/resource provisioning + cleanup
  migrations/                 # Validation + legacy remote D1 runner
  routes/
    auth.ts                   # OAuth login/callback
    me.ts                     # Current user
    projects.ts               # Project CRUD, migrations, logs, PG DB ops
    deploy.ts                 # Deploy pipeline
    delete.ts                 # Project deletion
    revalidate.ts             # Dashboard/admin ISR revalidation
    internal-revalidate.ts    # Proxy -> API ISR revalidation
    internal-resolve-resource.ts
    internal-resolve-worker.ts
    secrets.ts
    domains.ts
    usage.ts
  admin/
    routes/                   # Admin pages, users/projects/deployments/platform/signup-control
    views/                    # Hono JSX view layer
    middleware/auth.ts
drizzle/
  0000_*.sql
  0001_*.sql
  0002_*.sql
  0003_*.sql
```

## Main Route Groups

### Public API

- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `GET /me`
- `/projects/*`
  - CRUD
  - deploys and rollbacks
  - migrations and logs
  - secrets
  - domains
  - usage
  - PostgreSQL project database provisioning/update
- `GET /usage`

### Internal API

- `POST /internal/revalidate/:projectId`
- `POST /internal/resolve-resource/:projectId`
- `POST /internal/resolve-worker/:projectId`

### Admin UI

- `/admin/users`
- `/admin/projects`
- `/admin/deployments`
- `/admin/signup-control`
- `/admin/platform`

## Auth Flow

`GET /auth/login?redirect=...&provider=github|google` starts OAuth. After callback:

1. the API validates the signed state
2. exchanges the code with GitHub or Google
3. looks up an existing OAuth account
4. if needed, links the provider to an existing user with the same email
5. otherwise creates a new user
6. for GitHub logins, optionally grants preview access to a configured GitHub repository
7. signs a JWT and redirects back with `?token=...`

The CLI entrypoint is `void auth login`, not `void login`.

Dashboard auth uses the same JWT model, stored in the `void_token` cookie.

## Deploy Flow

`POST /projects/:id/deploy` handles both worker and static deploys.

### Worker deploys

1. validate ownership and deploy limits
2. provision bindings and queues from the manifest
3. upload worker modules and assets
4. upload a versioned worker: `user-{slug}-{deploymentId}`
5. call `POST /__void/migrate` on that new worker
6. update routing KV and active domains only after migrations succeed
7. mark the deployment live and run retention cleanup

### Static/SPA deploys

1. content-address assets by hash
2. store small assets in `STATIC_ASSETS` KV and large assets in `STATIC_ASSETS_R2`
3. write a manifest to `ROUTING`
4. point routing at `staticDeploymentId` instead of a worker

## Usage and Plan Enforcement

- **Deploy/day limits** are checked from the platform Postgres database.
- **Request usage** is counted asynchronously through `USAGE_QUEUE` and the `UsageCounter` DO.
- **Scheduled enforcement** runs hourly from the worker cron and reconciles request/AI usage against plan limits.
- **Per-request runtime limits** are carried in routing data and enforced by `dispatch`.

## Admin UI

The admin surface is built into this worker under `/admin/*`.

Notable sections:

- user search, plan changes, suspension controls
- project and deployment inspection
- deployment log viewing
- signup allowlist/private-beta controls
- platform worker version history and orchestrated rollback

## Local Setup and Secrets

Useful scripts:

```bash
pnpm -C packages/api dev
pnpm -C packages/api setup
pnpm -C packages/api db:generate
pnpm -C packages/api migrate
```

`pnpm -C packages/api setup` also ensures `packages/api/.dev.vars` and
`packages/dashboard/.dev.vars` include the local development overrides:
`DEV_AUTH_BYPASS=true`, `PLATFORM_ENV=staging`, `JWT_SECRET=dev`, and the local
Hyperdrive connection string. It also prompts for the local admin email and
upserts the seeded `user_admin` record to match it. For non-interactive use,
pass `pnpm -C packages/api setup -- --admin-email you@example.com`.

To run the API locally, use:

```bash
pnpm -C packages/api exec wrangler dev --local --host localhost --port 8787
```

Secrets used at runtime:

- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `CF_ZONE_ID`
- `JWT_SECRET`
- `PROJECT_SECRET_KEYS_JSON`
- `PROJECT_SECRET_ACTIVE_KEY_VERSION`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

`PROJECT_SECRET_KEYS_JSON` is a JSON object mapping key-version strings to base64-encoded 32-byte AES keys. `PROJECT_SECRET_ACTIVE_KEY_VERSION` selects which version is used for new project-secret writes.

Optional vars:

- `AUTH_REDIRECT_URI`
- `DASHBOARD_URL`
- `GITHUB_PREVIEW_REPO_PAT`
- `VOID_PROXY_SERVICE`
- `SITE_DOMAIN`

Set `GITHUB_PREVIEW_REPO_PAT` to automatically invite GitHub-authenticated users to `void-sdk/void` with read-only access. The PAT should be a fine-grained token with `Administration` repository permission `write` for that repository.

## Tests

Unit coverage includes provisioning, JWT/auth helpers, deploy manifest validation, usage counters, cron scheduling, and legacy D1 migration helpers.

Integration coverage includes:

- auth and `/me`
- project CRUD
- deploy/rollback/revalidation
- custom domains and secrets
- admin dashboard
- scheduled usage enforcement
