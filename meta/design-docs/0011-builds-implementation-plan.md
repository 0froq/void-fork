# Implementation Plan: Vite Cloud Builds Service

**Status:** Not started yet

## Context

Vite Cloud currently requires users to build locally via `vcc deploy`. This plan implements a remote build service triggered by GitHub push webhooks, running in Cloudflare Containers orchestrated by Durable Objects. The design is documented in `meta/design-docs/0010-builds.md`.

Two deploy paths will coexist:

- **`vcc deploy`** — build locally, upload artifacts (existing, unchanged)
- **GitHub push** — build remotely on Vite Cloud infra, deploy automatically

## Critical Files (Existing)

| File                                       | Purpose                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `packages/platform/src/routes/deploy.ts`   | Deploy pipeline (provision → migrate → R2 → WfP → KV) — must refactor for reuse |
| `packages/platform/src/index.ts`           | Hono app entry, route mounting, `scheduled()` handler                           |
| `packages/platform/src/env.ts`             | `PlatformEnv` type with all bindings                                            |
| `packages/platform/src/types.ts`           | `User`, `Project`, `Deployment`, `DeployManifest`, etc.                         |
| `packages/platform/src/db.ts`              | All D1 query helpers (`generateId`, CRUD functions)                             |
| `packages/platform/src/id.ts`              | `generateId(prefix)` — reuse for `bld_` and `ghc_` prefixes                     |
| `packages/platform/src/tiers.ts`           | `PlanLimits`, `PLAN_LIMITS`, `getPlanLimits()`                                  |
| `packages/platform/src/middleware/auth.ts` | JWT Bearer auth middleware                                                      |
| `packages/platform/wrangler.jsonc`         | Worker config (D1, KV, R2, dispatch, crons) — no DOs currently                  |
| `packages/vite-cloud/src/cli/package.ts`   | `packageBuild()`, `computeAssetHashes()`, `collectFiles()`                      |

---

## Step 1: Database Schema + Types + Helpers

### 1a. D1 migrations

**Create `packages/platform/migrations/0011_builds.sql`:**

```sql
CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'queued',
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  deployment_id TEXT REFERENCES deployments(id),
  error TEXT,
  exit_code INTEGER,
  instance_type TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_builds_project ON builds(project_id, created_at DESC);
CREATE INDEX idx_builds_status ON builds(status);
CREATE INDEX idx_builds_user_status ON builds(user_id, status);
```

**Create `packages/platform/migrations/0012_github_connections.sql`:**

```sql
CREATE TABLE github_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_github_repo ON github_connections(installation_id, repo_full_name);
```

### 1b. TypeScript interfaces

**Edit `packages/platform/src/types.ts`** — add:

```typescript
export interface Build {
  id: string;
  project_id: string;
  user_id: string;
  status: "queued" | "starting" | "building" | "deploying" | "complete" | "failed" | "cancelled";
  commit_sha: string;
  branch: string;
  deployment_id: string | null;
  error: string | null;
  exit_code: number | null;
  instance_type: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface GitHubConnection {
  id: string;
  project_id: string;
  installation_id: number;
  repo_full_name: string;
  branch: string;
  created_at: string;
}
```

### 1c. DB query helpers

**Edit `packages/platform/src/db.ts`** — add build + github_connection CRUD:

- `createBuild(db, projectId, userId, commitSha, branch): Build` — uses `generateId("bld")`
- `getBuild(db, id): Build | null`
- `getProjectBuilds(db, projectId, limit=10): Build[]`
- `updateBuildStatus(db, id, status, opts?: { error, exitCode, instanceType, startedAt, completedAt, deploymentId })`
- `countUserActiveBuilds(db, userId): number` — `WHERE status IN ('queued','starting','building','deploying')`
- `getQueuedBuilds(db, limit=50): (Build & { user_plan: string })[]` — joins users for plan
- `createGitHubConnection(db, projectId, installationId, repoFullName, branch): GitHubConnection`
- `getGitHubConnection(db, projectId): GitHubConnection | null`
- `getGitHubConnectionByRepo(db, installationId, repoFullName): (GitHubConnection & { user_id: string }) | null` — joins projects for user_id
- `deleteGitHubConnection(db, projectId): void`

Admin queries (for dashboard):

- `getAllBuildsWithProject(db, limit, offset): (Build & { project_slug: string | null })[]`
- `countBuilds(db): number`
- `getBuildByDeploymentId(db, deploymentId): Build | null` — for linking deployments to builds

### Verify

- `pnpm check` (types compile)
- Write unit tests for the new DB functions in `packages/platform/test/`

---

## Step 2: Tier System Update

**Edit `packages/platform/src/tiers.ts`:**

Add to `PlanLimits`:

```typescript
concurrentBuilds: number;
buildTimeoutMinutes: number;
```

Add to each plan:
| Plan | `concurrentBuilds` | `buildTimeoutMinutes` |
|------|--------------------|-----------------------|
| free | 1 | 10 |
| solo | 2 | 15 |
| pro | 3 | 15 |
| sponsored | 6 | 20 |
| custom | 0 (unlimited) | 0 (unlimited) |

Add helper:

```typescript
export function getBuildInstanceType(plan: string): string {
  const map: Record<string, string> = {
    free: "standard-1",
    solo: "standard-1",
    pro: "standard-2",
    sponsored: "standard-3",
    custom: "standard-3",
  };
  return map[plan] ?? "standard-1";
}
```

### Verify

- `pnpm check`
- Existing tier tests still pass

---

## Step 3: Refactor Deploy Pipeline

Extract the core deploy logic from the 408-line `POST /:id/deploy` handler into a reusable function so both the existing CLI deploy endpoint and the new internal build artifacts endpoint can call it.

**Create `packages/platform/src/deploy-pipeline.ts`:**

Extract from `deploy.ts`:

- `runDeployPipeline(env, project, user, formData, manifest, source): Promise<DeployResult>` — the full pipeline from "create deployment record" through "mark live"
- Move helper functions: `collectAssetEntries`, `uploadPool`, `clearIsrCache`, `guessContentType`

**Edit `packages/platform/src/routes/deploy.ts`:**

- `POST /:id/deploy` becomes: auth check → rate limit check → parse FormData → call `runDeployPipeline()`
- All the extracted helpers are imported from `deploy-pipeline.ts`

### Verify

- `pnpm check`
- Deploy a playground app with `vcc deploy` — must still work identically
- Run existing platform tests

---

## Step 4: Platform API Routes

### 4a. GitHub webhook handler

**Create `packages/platform/src/routes/webhooks.ts`:**

`POST /webhooks/github`:

1. Verify HMAC-SHA256 signature using `GITHUB_WEBHOOK_SECRET`
2. Parse event type from `X-GitHub-Event` header
3. For `push` events:
   - Extract `installation.id`, `repository.full_name`, `ref` (branch), `after` (commit SHA)
   - Look up project via `getGitHubConnectionByRepo(db, installationId, repoFullName)`
   - Check branch matches the configured branch
   - Insert build: `createBuild(db, projectId, userId, commitSha, branch)`
   - Poke scheduler DO: `env.BUILD_SCHEDULER.get(env.BUILD_SCHEDULER.idFromName("global")).fetch("/poke")`
4. For `installation` events (installed/uninstalled): log for now, handle later
5. Return 200 OK

**Mount in `index.ts`:**

```typescript
app.route("/webhooks", webhooks); // No auth middleware — uses webhook signature verification
```

### 4b. Build management routes

**Create `packages/platform/src/routes/builds.ts`:**

All routes use `authMiddleware` and ownership checks.

- `GET /:id/builds` — list builds for a project (`getProjectBuilds()`)
- `GET /:id/builds/:buildId` — get build status
- `POST /:id/builds/:buildId/cancel` — cancel a build:
  - If queued: update D1 status to `cancelled`
  - If active: forward cancel to BuildManager DO
- `GET /:id/builds/:buildId/logs` — WebSocket upgrade, proxy to BuildManager DO
- `POST /builds/:buildId/artifacts` — **internal endpoint**, authenticated with build token (not user JWT):
  - Verify build token (HMAC of build ID + secret)
  - Look up build → project → user
  - Parse FormData
  - Call `runDeployPipeline()`
  - Update build status to `complete` or `failed`

**Mount in `index.ts`:**

```typescript
app.use("/projects/*", authMiddleware);
app.route("/projects", builds);
// Internal artifacts endpoint (no user auth — build token auth)
app.post("/builds/:buildId/artifacts", buildArtifactsHandler);
```

### 4c. GitHub connection management routes

Add to `packages/platform/src/routes/builds.ts` (or a separate `github.ts`):

- `POST /:id/github` — connect a GitHub repo to a project (stores connection)
- `GET /:id/github` — get current GitHub connection
- `DELETE /:id/github` — disconnect

### 4d. Environment updates

**Edit `packages/platform/src/env.ts`:**

```typescript
// Add to Bindings:
BUILD_SCHEDULER: DurableObjectNamespace;
BUILD_MANAGER: DurableObjectNamespace;
GITHUB_APP_ID?: string;
GITHUB_APP_PRIVATE_KEY?: string;
GITHUB_WEBHOOK_SECRET?: string;
```

### Verify

- `pnpm check`
- Test webhook handler with a mock payload (unit test)
- Test build routes with mock data

---

## Step 5: BuildScheduler Durable Object

**Create `packages/platform/src/durable-objects/build-scheduler.ts`:**

```typescript
import { DurableObject } from "cloudflare:workers";

export class BuildScheduler extends DurableObject<PlatformEnv["Bindings"]> {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    // POST /poke — wake up and reschedule alarm
    await this.ctx.storage.setAlarm(Date.now() + 100); // immediate tick
    return new Response("ok");
  }

  async alarm() {
    // 1. Query D1 for queued builds (ordered by created_at)
    // 2. For each build:
    //    a. Look up user plan → get concurrentBuilds limit
    //    b. Count user's active builds
    //    c. If under limit:
    //       - Update build status to 'starting'
    //       - Get BuildManager DO stub: env.BUILD_MANAGER.get(env.BUILD_MANAGER.idFromName(buildId))
    //       - Call buildManager.startBuild(buildConfig) via RPC
    // 3. If there are still queued builds, reschedule alarm for +2s
    //    (don't reschedule if queue is empty — poke will restart)
  }
}
```

The scheduler only reschedules its alarm when there are queued builds. When the queue empties, it stops polling. The webhook handler pokes it awake when a new build is queued.

### Verify

- Unit test: mock D1 queries, verify concurrency enforcement
- Unit test: verify alarm rescheduling logic

---

## Step 6: BuildManager Durable Object + Container

**Create `packages/platform/src/durable-objects/build-manager.ts`:**

This is the most complex component. It extends `Container` from `@cloudflare/containers`.

```typescript
import { Container } from "@cloudflare/containers";

export class BuildManager extends Container<PlatformEnv["Bindings"]> {
  defaultPort = 4000;
  enableInternet = true;

  // RPC method called by BuildScheduler
  async startBuild(config: BuildConfig) {
    // 1. Store config in SQLite
    // 2. Set timeout alarm based on tier
    // 3. Start container with env vars:
    //    BUILD_ID, PROJECT_ID, SOURCE_URL, SOURCE_TOKEN,
    //    BUILD_TOKEN, PLATFORM_URL, DO_URL
  }

  override onStart() {
    // Container ready — update D1 build status to 'building'
  }

  override onStop({ exitCode, reason }) {
    // Build finished — update D1 build status based on exit code
    // Notify scheduler if needed
  }

  override onError(error: string) {
    // Container crashed — mark build as failed
  }

  async alarm() {
    // Build timeout — send SIGTERM to container, mark as failed
  }

  // HTTP endpoints (called by container agent)
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/logs" && request.method === "POST") {
      // Receive batched log lines from container
      // Store in SQLite, broadcast to WebSocket clients
    }

    if (url.pathname === "/status" && request.method === "POST") {
      // Receive status updates from container (building → deploying)
    }

    if (request.headers.get("Upgrade") === "websocket") {
      // Accept WebSocket for log streaming
      // Send buffered logs from SQLite, then live-stream
    }

    return new Response("not found", { status: 404 });
  }
}
```

### GitHub App token generation

**Create `packages/platform/src/github/token.ts`:**

- `generateInstallationToken(appId, privateKey, installationId): string` — Creates JWT signed with app private key, calls `POST /app/installations/{id}/access_tokens`
- `generateSourceUrl(repoFullName, commitSha): string` — Returns `https://api.github.com/repos/{owner}/{repo}/tarball/{sha}`

### Build token generation

**Create `packages/platform/src/auth/build-token.ts`:**

- `generateBuildToken(buildId, secret): string` — HMAC-SHA256 of build ID
- `verifyBuildToken(buildId, token, secret): boolean`

### Verify

- Unit test BuildManager state machine transitions
- Unit test WebSocket log buffering and replay
- Unit test alarm timeout handling

---

## Step 7: Wrangler Configuration

**Edit `packages/platform/wrangler.jsonc`:**

```jsonc
{
  // ... existing config ...

  // Add container definition
  "containers": [
    {
      "class_name": "BuildManager",
      "image": "./container/Dockerfile",
      "max_instances": 50,
    },
  ],

  // Add Durable Object bindings
  "durable_objects": {
    "bindings": [
      {
        "name": "BUILD_SCHEDULER",
        "class_name": "BuildScheduler",
      },
      {
        "name": "BUILD_MANAGER",
        "class_name": "BuildManager",
      },
    ],
  },

  // Add DO migration (required for SQLite-backed DOs)
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["BuildScheduler", "BuildManager"],
    },
  ],

  // ... staging env needs equivalent config with separate container/DO resources ...
}
```

**Update exports in `packages/platform/src/index.ts`:**

```typescript
export { BuildScheduler } from "./durable-objects/build-scheduler";
export { BuildManager } from "./durable-objects/build-manager";
```

Add new secrets (via `wrangler secret put`):

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

### Verify

- `wrangler dev` starts without errors
- DOs are accessible via bindings

---

## Step 8: Build Container Image

**Create `packages/platform/container/Dockerfile`:**

```dockerfile
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN npm install -g bun
COPY build-agent.mjs /build-agent.mjs
EXPOSE 4000
CMD ["node", "/build-agent.mjs"]
```

**Create `packages/platform/container/build-agent.mjs`:**

The agent script handles the full build lifecycle inside the container:

1. **HTTP server** on port 4000:
   - `GET /` — health check (returns 200)
   - `POST /cancel` — set cancellation flag, SIGTERM child processes

2. **Build pipeline** (runs on startup after server is ready):
   - Read config from env vars (`BUILD_ID`, `PROJECT_ID`, `SOURCE_URL`, `SOURCE_TOKEN`, `BUILD_TOKEN`, `PLATFORM_URL`, `DO_URL`)
   - Download tarball: `curl -sL -H "Authorization: token $TOKEN" "$URL" | tar xz --strip-components=1`
   - Detect package manager from lockfile (`pnpm-lock.yaml` → pnpm, `package-lock.json` → npm, `bun.lock` → bun)
   - Install dependencies
   - Run `npx vite build`
   - Package build output (replicate `packageBuild()` logic — read dist/, build FormData)
   - Check assets delta: `POST /projects/{id}/assets/check` on platform
   - POST FormData to `POST /builds/{id}/artifacts` on platform with build token

3. **Log streaming**: Buffer stdout/stderr, POST to DO every 500ms:

   ```
   POST $DO_URL/logs
   Body: [{ "line": "...", "ts": 1234567890 }, ...]
   ```

4. **Status reporting**: POST to DO on state changes:

   ```
   POST $DO_URL/status
   Body: { "status": "building" | "deploying" }
   ```

5. **Exit**: 0 on success, 1 on failure. The DO's `onStop()` hook handles status updates.

### Verify

- Build the Docker image locally: `docker build -t vite-cloud-builder packages/platform/container/`
- Test the agent with a mock project (mount a test project as volume)

---

## Step 9: Admin Dashboard — Builds View

Add a Builds section to the admin dashboard, following the existing pattern of server-rendered Hono JSX pages with pagination.

### Existing admin patterns to follow

- Layout: `src/admin/views/layout.tsx` — shared nav bar + page chrome
- List view: `src/admin/views/deployments-list.tsx` — table with badge-colored status, pagination
- Detail view: `src/admin/routes/deployments.tsx` — status, error card, metadata table
- Route mounting: `src/index.ts` lines 40-44 — `app.route("/admin/builds", adminBuilds)`
- Nav: `src/admin/views/layout.tsx` line 66 — add `<a href="/admin/builds">Builds</a>` after Deployments

### New files

**Create `packages/platform/src/admin/views/builds-list.tsx`:**

- Paginated table of builds with columns: ID, Project, Branch, Commit, Status, Error, Duration, Created
- Status badges: `complete` → green, `failed` → red, `building`/`deploying` → blue, `queued`/`starting` → gray, `cancelled` → gray
- Commit SHA truncated to 7 chars, links to GitHub commit (if github_connection exists)
- Duration column: `completedAt - startedAt` formatted as "Xs" or "Xm Ys"

**Create `packages/platform/src/admin/routes/builds.tsx`:**

`GET /builds` — list page:

- Query `getAllBuildsWithProject()` with pagination
- Render `BuildsListPage`

`GET /builds/:id` — detail page:

- Query `getBuild()` + `getProject()` + `getGitHubConnection()`
- Show: build ID, project link, status badge, commit SHA, branch, instance type, timing (created → started → completed)
- If `error` is set: show error card (red background, same as deployment error card)
- If `deployment_id` is set: link to `/admin/deployments/:deploymentId`
- Build logs section: fetch logs from BuildManager DO via internal fetch, display in a `<pre>` block

### Modify existing views

**Edit `packages/platform/src/admin/views/layout.tsx`:**

- Add `<a href="/admin/builds">Builds</a>` to nav bar after Deployments link

**Edit `packages/platform/src/admin/routes/deployments.tsx`:**

- In `GET /deployments/:id` detail view, add a row to the table:
  - "Build" row: query `getBuildByDeploymentId(db, deployment.id)` — if found, render link to `/admin/builds/:buildId` with build status badge
  - If no build found, show "-" (deploy was via `vcc deploy`, not a remote build)

**Edit `packages/platform/src/admin/views/deployments-list.tsx`:**

- Add "Build" column to the table — shows build ID link if the deployment has an associated build, "-" otherwise
- Requires the list query to join builds: `getAllDeploymentsWithProject()` → also LEFT JOIN builds ON `builds.deployment_id = deployments.id`

**Edit `packages/platform/src/admin/views/dashboard.tsx`:**

- Add build count stat card to the system dashboard (alongside existing users/projects/deployments counts)

**Mount in `src/index.ts`:**

```typescript
import adminBuilds from "./admin/routes/builds";
app.route("/admin/builds", adminBuilds);
```

### Verify

- Navigate to `/admin/builds` — paginated list renders
- Click a build → detail page with status, error, logs
- Navigate to `/admin/deployments/:id` — "Build" row shows link to associated build (or "-")
- Dashboard stat card shows build count

---

## Step 10: Integration Testing

1. **End-to-end with wrangler dev:**
   - Start platform worker with `wrangler dev`
   - Create a project and link a GitHub repo (manually via API)
   - Simulate a webhook push event via curl
   - Verify: build row created → scheduler picks it up → container starts → build runs → artifacts uploaded → deployment live

2. **Unit tests for each component:**
   - Webhook signature verification
   - Build DB helpers
   - Scheduler concurrency logic
   - BuildManager state machine
   - Build token generation/verification
   - Deploy pipeline extraction (regression test existing deploys)

3. **Verify existing functionality:**
   - `pnpm vitest --run` — all 882+ existing tests pass
   - `cd playground/spa && pnpm dev` — still works
   - `pnpm lint && pnpm fmt && pnpm check`

---

## Step 11: Documentation

- Update `meta/design-docs/0010-builds.md` status from "Design" to "Implemented"
- Update `README.md` (CLAUDE.md source of truth):
  - Add builds system to platform overview
  - Add new secrets to environment docs
  - Update test counts
- Update `packages/platform/README.md` with new routes, DOs, container config
- Update `meta/progress.md` with builds milestone

---

## New Files Summary

| File                                                       | Purpose                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/platform/migrations/0011_builds.sql`             | Builds table                                                       |
| `packages/platform/migrations/0012_github_connections.sql` | GitHub repo connections table                                      |
| `packages/platform/src/deploy-pipeline.ts`                 | Extracted deploy pipeline (shared by deploy + artifacts endpoints) |
| `packages/platform/src/routes/webhooks.ts`                 | GitHub webhook handler                                             |
| `packages/platform/src/routes/builds.ts`                   | Build status, cancel, logs, artifacts, GitHub connection routes    |
| `packages/platform/src/durable-objects/build-scheduler.ts` | BuildScheduler DO                                                  |
| `packages/platform/src/durable-objects/build-manager.ts`   | BuildManager DO + Container                                        |
| `packages/platform/src/github/token.ts`                    | GitHub App JWT + installation token generation                     |
| `packages/platform/src/auth/build-token.ts`                | Build token generation/verification                                |
| `packages/platform/container/Dockerfile`                   | Build container image                                              |
| `packages/platform/container/build-agent.mjs`              | Build agent script                                                 |
| `packages/platform/src/admin/views/builds-list.tsx`        | Admin builds list view                                             |
| `packages/platform/src/admin/routes/builds.tsx`            | Admin builds routes                                                |

## Modified Files Summary

| File                                                     | Changes                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/platform/src/types.ts`                         | Add `Build`, `GitHubConnection` interfaces                              |
| `packages/platform/src/db.ts`                            | Add build + github_connection CRUD functions                            |
| `packages/platform/src/tiers.ts`                         | Add `concurrentBuilds`, `buildTimeoutMinutes`, `getBuildInstanceType()` |
| `packages/platform/src/env.ts`                           | Add DO bindings, GitHub App secrets to `PlatformEnv`                    |
| `packages/platform/src/index.ts`                         | Mount webhook/build routes, export DO classes                           |
| `packages/platform/src/routes/deploy.ts`                 | Refactor to use `runDeployPipeline()` from deploy-pipeline.ts           |
| `packages/platform/wrangler.jsonc`                       | Add containers, durable_objects, migrations (prod + staging)            |
| `packages/platform/src/admin/views/layout.tsx`           | Add Builds nav link                                                     |
| `packages/platform/src/admin/routes/deployments.tsx`     | Add build link to deployment detail                                     |
| `packages/platform/src/admin/views/deployments-list.tsx` | Add Build column                                                        |
| `packages/platform/src/admin/views/dashboard.tsx`        | Add build count stat card                                               |
