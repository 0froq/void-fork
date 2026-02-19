# @vite-cloud/platform

Control Plane API + Admin Dashboard. CF Worker using Hono, D1, R2, KV, and Workers for Platforms (dispatch namespaces). No tsdown — wrangler handles TS bundling.

## Source Layout

```
src/
  index.ts                  # Hono app + scheduled handler (cron), mounts route groups + auth middleware
  env.ts                    # PlatformEnv type (D1, R2, KV, DISPATCH, secrets, Variables)
  types.ts                  # User, Project, Deployment, Resource, DeployManifest
  id.ts                     # generateId(prefix) → "proj_a1b2c3d4e5f6"
  db.ts                     # Typed D1 query wrappers (CRUD for all tables)
  tiers.ts                  # PlanId, PlanLimits, PLAN_LIMITS constants, getPlanLimits(), isWithinLimit()
  auth/
    jwt.ts                  # HS256 JWT sign/verify via Web Crypto API
    github.ts               # GitHub OAuth helpers (authorize URL, code→token, user profile)
    google.ts               # Google OAuth helpers (authorize URL, code→token, user profile)
    hmac.ts                 # HMAC state signing/verification for OAuth flows
  middleware/
    auth.ts                 # Bearer token verification, sets userId/userLogin on context
  admin/
    middleware/auth.ts      # Cookie-based JWT auth + role === "admin" check
    routes/login.ts         # GET /admin/login, /admin/login/google, /admin/callback, /admin/logout
    routes/system.tsx       # GET /admin/ (dashboard home with stats)
    routes/users.tsx        # GET /admin/users, GET /admin/users/:id, POST plan/suspend/unsuspend
    routes/projects.tsx     # GET /admin/projects, GET /admin/projects/:id
    routes/deployments.tsx  # GET /admin/deployments, GET /admin/deployments/:id
    views/layout.tsx        # HTML shell (head, nav, body)
    views/dashboard.tsx     # System stats overview
    views/users-list.tsx    # Users table with search/filter form
    views/user-detail.tsx   # User profile, projects, plan limits, deploy count, suspend button
    views/projects-list.tsx # All projects table
    views/deployments-list.tsx # Deployments table with error preview column
    views/pagination.tsx    # Reusable pagination component
    views/format.ts         # Shared formatting helpers (formatBytes, formatNumber, formatLimit)
  migrations/
    remote-runner.ts        # Executes migrations on remote D1 via CF REST API
    validate.ts             # Server-side destructive-op validation (defense in depth)
  routes/
    auth.ts                 # OAuth login + callback (GitHub/Google)
    projects.ts             # Projects CRUD + deployments + migrations list
    deploy.ts               # Asset check + full deploy pipeline
    delete.ts               # Project deletion + CF resource cleanup
    revalidate.ts           # ISR cache purge (paths or all)
    secrets.ts              # Worker secret management (put/delete)
    domains.ts              # Custom domain CRUD + CF for SaaS
    usage.ts                # Usage queries (per-project + aggregate)
migrations/
  0001_initial.sql          # users, projects, deployments, resources tables
  0002_provider_auth.sql    # Migrate users to provider-agnostic schema
  ...
  0006_usage_tiers.sql      # Add plan column to users table
```

## API Endpoints

All endpoints except `/health`, `/auth/*`, and `/admin/*` require Bearer token authentication. Project endpoints verify ownership (`project.user_id === userId`). Admin dashboard uses cookie-based auth with `role === "admin"` check.

```
GET    /health                           # Health check
GET    /auth/login                       # OAuth initiation (GitHub/Google)
GET    /auth/callback                    # OAuth callback → JWT
GET    /me                               # Current user info

GET    /projects                         # List user's projects
POST   /projects                         # Create project (slug + name)
GET    /projects/:id                     # Get project
GET    /projects/:id/deployments         # List deployments
GET    /projects/:id/migrations          # Get applied migrations
DELETE /projects/:id                     # Delete project + all CF resources

POST   /projects/:id/assets/check        # Check which assets need uploading
POST   /projects/:id/deploy              # Full deploy (migrations → assets → worker)
POST   /projects/:id/revalidate          # Purge ISR cache (specific paths or all)

PUT    /projects/:id/secrets/:name       # Set/update a worker secret
DELETE /projects/:id/secrets/:name       # Delete a worker secret

POST   /projects/:id/domains             # Add custom domain
GET    /projects/:id/domains             # List custom domains
GET    /projects/:id/domains/:domainId   # Get domain status (polls CF API)
DELETE /projects/:id/domains/:domainId   # Remove custom domain

GET    /projects/:id/usage               # Project usage (current billing period)
GET    /usage                            # Aggregate usage across all projects

# Admin dashboard (HTML, cookie-based auth)
GET    /admin/login                      # Login page
GET    /admin/login/google               # Google OAuth initiation
GET    /admin/callback                   # OAuth callback → set cookie
GET    /admin/logout                     # Clear cookie
GET    /admin/                           # Dashboard (stats + recent projects)
GET    /admin/users                      # Users list (paginated, searchable)
GET    /admin/users/:id                  # User detail (plan, usage, suspension)
POST   /admin/users/:id/plan             # Change plan
POST   /admin/users/:id/suspend          # Suspend user
POST   /admin/users/:id/unsuspend        # Unsuspend user
GET    /admin/projects                   # All projects list
GET    /admin/projects/:id               # Project detail (resources, deployments, domains)
GET    /admin/deployments                # All deployments list
GET    /admin/deployments/:id            # Deployment detail (manifest, errors)
```

## Auth Flow

`GET /auth/login?redirect=http://localhost:{port}/callback&provider=github|google` → HMAC-signed state (includes `provider`) → GitHub or Google OAuth → `GET /auth/callback` → extract `provider` from state → exchange code → upsert user (with duplicate email check across providers) → sign JWT → redirect to CLI with `?token=`.

The CLI's `vcd login` prompts user to choose GitHub or Google, then passes `provider` in the query string. On email conflict (same email registered under different provider), the callback redirects with `?error=email_conflict&existing_provider=...`.

The `User` type uses provider-agnostic columns: `provider` (`"github"` | `"google"`), `provider_id` (TEXT — GitHub numeric ID cast to string, Google opaque sub), `login` (GitHub username or Google email), `plan` (defaults to `"free"`).

Auth middleware on `/projects/*` extracts Bearer token, verifies JWT, sets `c.get("userId")` and `c.get("userLogin")`. Deploy endpoint checks `project.user_id === c.get("userId")` for ownership.

## Deploy Endpoint Flow

`POST /projects/:id/deploy` receives multipart form data:

1. Ownership check: `project.user_id` must match authenticated user
2. **Deploy count enforcement**: Look up user plan, check `countUserDeploymentsToday()` against `planLimits.deploysPerDay` → 429 if exceeded
3. Provision bindings (D1, KV, R2) — creates CF resources if needed
4. `migration:<name>` fields → validated, then executed on D1 via CF REST API (status: `"migrating"`)
5. `asset:<path>` fields → stored in R2 at `{projectId}/current/{path}`
6. `worker:<path>` fields → uploaded to CF dispatch namespace via API
7. KV routing updated: `slug → { workerName, projectId, version, limits?, suspended? }`
   - `limits` includes `cpuMs` and `subRequests` from user's plan (omitted when all unlimited)
   - `suspended` is carried forward from the existing KV entry to avoid race conditions with cron
8. Deployment marked as `live`

**Key invariant:** Worker is never deployed unless all migrations succeed. On migration failure, deployment is marked `"failed"` with an `error_message` and the existing worker keeps running. All 5 failure points (destructive validation, missing D1, migration error, worker upload, catch-all) store a descriptive `error_message` in the deployment row.

## Usage Metering & Tiers

Five plan tiers: `free`, `solo`, `pro`, `sponsored`, `custom`. Defined in `src/tiers.ts` with `PLAN_LIMITS` constant. `0` = unlimited for any field. The `isWithinLimit(limit, current)` helper centralizes the unlimited-check logic.

- **Immediate enforcement**: Deploy count per day (checked at deploy time via D1 query)
- **Per-request enforcement**: CPU time and sub-requests via CF Custom Limits (passed in KV routing `limits` field, applied by dispatch worker)
- **Async enforcement**: Request count per month via Cron Trigger (`*/5 * * * *`) — queries Analytics Engine, sets/clears `suspended` flag in KV routing entries
- **Usage queries**: `GET /projects/:id/usage` (per-project) and `GET /usage` (aggregate) query Analytics Engine SQL API with `_sample_interval` multiplier

The platform default export is `{ fetch: app.fetch, scheduled }` — `app` (the Hono instance) is also exported as a named export for integration tests.

## Admin Dashboard

Integrated into the platform worker at `/admin/*`. Uses Hono JSX (server-rendered HTML) with cookie-based JWT auth, separate from the Bearer token auth used by API endpoints.

**Auth**: Cookie-based — Google OAuth flow at `/admin/login/google` → set `admin_token` cookie → verify `role === "admin"`. The OAuth callback URL is derived from the request origin (`new URL(c.req.url).origin + "/admin/callback"`), so no separate env var is needed. `DEV_AUTH_BYPASS=true` in `.dev.vars` skips OAuth for local development.

## Secrets (via `wrangler secret put`)

| Secret                 | Staging notes                                        |
| ---------------------- | ---------------------------------------------------- |
| `CF_API_TOKEN`         | Can share with production                            |
| `CF_ACCOUNT_ID`        | Can share with production                            |
| `CF_ZONE_ID`           | Can share with production                            |
| `JWT_SECRET`           | Must differ from production                          |
| `GITHUB_CLIENT_ID`     | Can share with production (add staging callback URL) |
| `GITHUB_CLIENT_SECRET` | Can share with production                            |
| `GOOGLE_CLIENT_ID`     | Can share with production (add staging callback URL) |
| `GOOGLE_CLIENT_SECRET` | Can share with production                            |

`AUTH_REDIRECT_URI` is set as a `vars` entry in wrangler config for staging (`https://platform.staging.vite.cloud/auth/callback`). For local dev, set `AUTH_REDIRECT_URI=http://localhost:8787/auth/callback` and `DEV_AUTH_BYPASS=true` in `.dev.vars`.

## Cloudflare API Token Permissions

Two tokens are needed: a **deploy token** (used by wrangler / CI) and a **runtime token** (used by the platform worker to provision user resources). A single token can serve both roles if it has the union of all permissions.

**Account-wide features** (enabled on the account, not configurable per-token): Workers for Platforms, Cloudflare for SaaS.

### Deploy Token (`CLOUDFLARE_API_TOKEN`)

Used by `pnpm run deploy` and GitHub Actions to deploy platform and dispatch workers.

**Account permissions:**

| Permission         | Access | Reason                               |
| ------------------ | ------ | ------------------------------------ |
| Workers Scripts    | Edit   | Deploy platform and dispatch workers |
| Workers KV Storage | Edit   | KV namespace bindings (ROUTING)      |
| D1                 | Edit   | D1 database bindings (DB)            |
| Workers R2 Storage | Edit   | R2 bucket bindings (ASSETS)          |

**Zone permissions** (on `vitecloud.app`):

| Permission     | Access | Reason                                               |
| -------------- | ------ | ---------------------------------------------------- |
| Workers Routes | Edit   | Dispatch worker route patterns (`*.vitecloud.app/*`) |
| DNS            | Read   | Zone lookup for route binding                        |

### Runtime Token (`CF_API_TOKEN` secret)

Used by the platform worker at runtime to provision and manage user resources via the CF REST API.

**Account permissions:**

| Permission         | Access | Reason                                                 |
| ------------------ | ------ | ------------------------------------------------------ |
| Workers Scripts    | Edit   | Upload/delete user workers in dispatch namespace       |
| D1                 | Edit   | Create databases, execute migrations, delete databases |
| Workers KV Storage | Edit   | Create/delete KV namespaces                            |
| Workers R2 Storage | Edit   | Create/delete R2 buckets                               |
| Account Analytics  | Read   | Query Analytics Engine SQL API for usage metering      |

**Zone permissions** (on `vitecloud.app`):

| Permission           | Access | Reason                                      |
| -------------------- | ------ | ------------------------------------------- |
| SSL and Certificates | Edit   | Custom hostname DV certificate provisioning |

## Tests

### Unit Tests

| Test file                         | Covers                                             |
| --------------------------------- | -------------------------------------------------- |
| `test/unit/provision.test.ts`     | Binding provisioning engine (7 tests)              |
| `test/unit/jwt.test.ts`           | JWT sign/verify round-trip (5 tests)               |
| `test/unit/remote-runner.test.ts` | Remote D1 migration execution (7 tests)            |
| `test/unit/tiers.test.ts`         | Plan limits, getPlanLimits(), isWithinLimit() (11) |

### Integration Tests

Integration tests call the Hono app via `app.fetch(request, env)` with **real** Miniflare D1/KV/R2 bindings and **mocked** external fetch calls (GitHub API, CF API). This tests the full request→middleware→route→DB→response chain.

| Test file                                  | Covers                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `test/integration/api-health.test.ts`      | Health endpoint smoke test (1 test)                                                                                 |
| `test/integration/api-me.test.ts`          | Auth middleware: missing/invalid/expired JWT, valid (4)                                                             |
| `test/integration/api-projects.test.ts`    | Projects CRUD: auth, list, create, validation, dupes (12)                                                           |
| `test/integration/api-deploy.test.ts`      | Deploy pipeline: auth, provisioning, migrations, R2, KV, limits, failure modes (33)                                 |
| `test/integration/admin-dashboard.test.ts` | Admin dashboard: auth, pages, forms, search, pagination, deployments, error display, plan limits, login/logout (28) |

Shared helpers in `test/integration/helpers.ts`:

- `setupEnv()` / `teardownEnv()` — Miniflare lifecycle (D1, KV, R2 bindings)
- `clearTables()` — D1 cleanup between tests (FK order)
- `createTestUser()` / `createTestProject()` / `createTestDeployment()` — factories with JWT signing
- `mockCfApi()` — URL-based fetch mock for CF API with configurable overrides
