# Builds — CI/Build Service

**Date:** 2026-02-19
**Status:** Design

---

## Summary

Move the build step from the user's machine to Void's infrastructure. A `git push` queues a build that runs in a Cloudflare Container, orchestrated by Durable Objects. The user views build logs in real-time via the dashboard.

Two deploy paths:

- **`void deploy`** — build locally, upload artifacts (existing, unchanged)
- **GitHub push** — build remotely on Void infra, deploy automatically

**Goal:** `git push` → build → deploy, with no local toolchain required.

---

## Architecture Overview

```
GitHub push webhook
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  Platform Worker                                              │
│                                                               │
│  POST /webhooks/github       → verify, lookup project, queue  │
│  GET  /projects/:id/builds   → list builds from D1           │
│  GET  /builds/:id            → build status from D1          │
│  WS   /builds/:id/logs       → proxy WebSocket to DO         │
│  POST /builds/:id/cancel     → RPC to BuildManager DO        │
│  POST /builds/:id/artifacts  → (internal) run deploy pipeline │
└──────────────────────┬───────────────────────────────────────┘
                       │
          BuildScheduler DO (alarm every 2s)
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  BuildManager DO + Container  (one per build)                 │
│                                                               │
│  DO side:                          Container side:            │
│  ┌─────────────────────┐          ┌────────────────────────┐  │
│  │ State machine        │          │ build-agent            │  │
│  │ SQLite: logs, state  │◄── HTTP ─┤                        │  │
│  │ WebSocket: log stream│          │ 1. Download tarball    │  │
│  │ Alarm: build timeout │          │ 2. Detect pkg manager  │  │
│  │                      │          │ 3. Install deps        │  │
│  │ onStop(): update D1, │          │ 4. vite build          │  │
│  │   notify scheduler   │          │ 5. Package artifacts   │  │
│  └─────────────────────┘          │ 6. POST to platform    │  │
│                                    └────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. BuildScheduler DO

A single global instance (addressed as `"global-scheduler"`). Runs a polling loop via Durable Object alarms.

**Responsibilities:**

- Poll D1 every 2s for builds with `status = 'queued'`
- Enforce per-user concurrency limits based on plan tier
- Start builds by calling `env.BUILD_MANAGER.get(buildId).startBuild(config)`
- Reschedule its own alarm after each tick

**Concurrency limits by tier:**

| Tier | Concurrent Builds | Build Timeout | Container Instance                        |
| ---- | ----------------- | ------------- | ----------------------------------------- |
| Free | 1                 | 10 min        | `standard-1` (0.5 vCPU, 4 GiB, 8 GB disk) |
| Pro  | 3                 | 15 min        | `standard-2` (1 vCPU, 6 GiB, 12 GB disk)  |
| Team | 6                 | 20 min        | `standard-3` (2 vCPU, 8 GiB, 16 GB disk)  |

**Scheduling algorithm (Phase 1):**

```
alarm():
  builds = D1.query("SELECT * FROM builds WHERE status = 'queued' ORDER BY created_at")
  for each build:
    user = lookupUser(build.user_id)
    activeCount = D1.query("SELECT COUNT(*) FROM builds WHERE user_id = ? AND status IN ('starting', 'building', 'deploying')")
    limit = tierLimit(user.tier)
    if activeCount < limit:
      D1.update(build.id, status = 'starting')
      env.BUILD_MANAGER.get(build.id).startBuild(config)
  setAlarm(now + 2000)
```

**Why a scheduler instead of starting builds immediately:**

- Fairness: prevents one user from consuming all capacity
- Tier enforcement: checked centrally, not race-prone
- System-level limits: can cap total concurrent builds across all users
- Queue ordering: FIFO by default, priority by tier later

### 2. BuildManager DO (extends Container)

One instance per build. The `Container` class from `@cloudflare/containers` extends `DurableObject`, so the DO and container are a single unit.

**State machine:**

```
             ┌─ cancel ─→ cancelled
             │
queued ──→ starting ──→ building ──→ deploying ──→ complete
             │             │            │
             └─────────────┴────────────┴──→ failed (+ error, exit code)
```

**DO responsibilities:**

- Start the container with build config as env vars
- Set a timeout alarm (10/15/20 min based on tier)
- Accept WebSocket connections for real-time log streaming
- Receive log lines from the container via HTTP POST (batched every 500ms)
- Store logs in SQLite for historical retrieval
- Broadcast log lines to all connected WebSocket clients
- On container stop: update D1 build status, clean up

**Container communication:**

- Container → DO: `POST /logs` (batched log lines), `POST /status` (state transitions)
- DO → Container: `POST /cancel` (graceful shutdown signal)

**Lifecycle hooks:**

```typescript
export class BuildManager extends Container {
  defaultPort = 4000;
  enableInternet = true; // npm install needs outbound

  override onStart() {
    // Container is up, health check passed
    this.transition("building");
  }

  override onStop({ exitCode, reason }) {
    if (this.state === "deploying" && exitCode === 0) {
      this.transition("complete");
    } else if (exitCode !== 0) {
      this.transition("failed", `Exit code ${exitCode}: ${reason}`);
    }
  }

  override onError(error: string) {
    this.transition("failed", error);
  }
}
```

### 3. Build Container

A minimal Docker image that runs the build-agent script.

**Dockerfile:**

```dockerfile
FROM node:24-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY build-agent.mjs /build-agent.mjs
EXPOSE 4000
CMD ["node", "/build-agent.mjs"]
```

**build-agent responsibilities:**

1. Start HTTP server on port 4000 (health check for DO, receives cancel signal)
2. Download source tarball from GitHub (URL + token passed as env vars)
3. Extract into working directory
4. Detect package manager from lockfile
5. Install dependencies (`pnpm install`, `npm install`, or `bun install`)
6. Run `npx vite build`
7. Package build output into the same FormData format as `void deploy`
8. POST artifacts to `POST /builds/:id/artifacts` on the platform
9. Stream stdout/stderr to the DO via periodic `POST /logs` (every 500ms)
10. Exit 0 on success, non-zero on failure

**Environment variables passed to container:**

```
BUILD_ID          - unique build identifier
PROJECT_ID        - vite cloud project id
SOURCE_URL        - GitHub tarball URL (with auth token embedded or separate)
SOURCE_TOKEN      - GitHub installation access token (1hr TTL)
BUILD_TOKEN       - short-lived token for POST /builds/:id/artifacts
PLATFORM_URL      - e.g. https://api.void.cloud
DO_URL            - BuildManager DO URL for log streaming
```

---

## Source Code Delivery

**Phase 1: GitHub tarball API** (simplest, fastest)

|                           | Git Clone (--depth 1) | GitHub Tarball         |
| ------------------------- | --------------------- | ---------------------- |
| Download size (50MB repo) | ~15-20MB              | ~5-10MB                |
| Time                      | 2-3s                  | <1s                    |
| Image bloat               | +50MB (git)           | +0 (curl/tar built-in) |
| Submodules                | Yes                   | No                     |
| Git history               | Yes                   | No                     |

Flow:

1. Platform has GitHub App installation token (from webhook or stored)
2. Generates tarball URL: `https://api.github.com/repos/{owner}/{repo}/tarball/{sha}`
3. Passes URL + token to container as env vars
4. Container: `curl -sL -H "Authorization: token $TOKEN" "$URL" | tar xz --strip-components=1`

Git clone can be added as an option later for repos needing submodules or git history.

---

## Artifact Flow

The container produces the **exact same FormData** that `void deploy` produces today:

| FormData key       | Content                                                       |
| ------------------ | ------------------------------------------------------------- |
| `manifest`         | JSON: bindings, migrations, schedules, SSR, assetHashes, etc. |
| `worker:<path>`    | Worker JS module blobs                                        |
| `asset:<path>`     | Static asset blobs (after delta check)                        |
| `migration:<name>` | SQL migration files                                           |
| `source`           | `"github"`                                                    |

The container POSTs this to `POST /builds/:id/artifacts`, a new internal endpoint authenticated with the build token. This endpoint runs the **existing deploy pipeline** (provision bindings → migrations → R2 upload → WfP upload → KV routing).

This means:

- Zero changes to the deploy logic
- CLI deploys (`void deploy`) continue working unchanged
- The build service is purely additive

---

## Log Streaming

```
Container ──POST /logs (batch)──→ BuildManager DO ──WebSocket──→ Dashboard
                                       │
                                  SQLite storage
                                  (historical retrieval)
```

**Container → DO:** Every 500ms, the build-agent collects buffered stdout/stderr lines and POSTs them to the DO's HTTP endpoint. Each batch is an array of `{ line, timestamp }` objects.

**DO → Clients:** The DO broadcasts each batch to all connected WebSocket clients immediately on receipt. Lines are also appended to SQLite for clients that connect mid-build or after completion.

**Client reconnection:** On WebSocket connect, the DO sends all stored log lines (from SQLite) followed by a `{ type: "caught_up" }` marker, then live-streams new lines.

---

## Platform API Endpoints

### `POST /webhooks/github`

Receives GitHub push webhooks. Verifies HMAC-SHA256 signature, looks up project by `installation_id` + `repo_full_name`, checks branch filter, inserts build row into D1, and pokes the BuildScheduler DO alarm.

### `GET /projects/:id/builds`

List recent builds for a project. Paginated.

### `GET /builds/:id`

Get build status, duration, error message.

### `GET /builds/:id/logs` (WebSocket upgrade)

Stream build logs in real-time. Proxied to the BuildManager DO.

### `POST /builds/:id/cancel`

Cancel a queued or in-progress build. If queued, marks as cancelled in D1. If in-progress, sends cancel signal to the BuildManager DO, which sends SIGTERM to the container.

### `POST /builds/:id/artifacts` (internal)

Receives the build FormData from the container. Authenticated with the build-specific token. Runs the deploy pipeline.

---

## D1 Schema

```sql
CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  -- queued | starting | building | deploying | complete | failed | cancelled
  commit_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  error TEXT,
  exit_code INTEGER,
  instance_type TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX idx_builds_project ON builds(project_id, created_at DESC);
CREATE INDEX idx_builds_status ON builds(status);
CREATE INDEX idx_builds_user_status ON builds(user_id, status);
```

---

## GitHub App Integration

Builds are triggered exclusively by GitHub pushes. The GitHub repo is the source of truth for remote builds. Local builds remain available via `void deploy`.

### Setup Flow

1. User installs the Void GitHub App on their repo (via dashboard or `void init --github`)
2. Platform stores the installation ID and repo mapping in D1
3. User configures which branch triggers deploys (default: `main`)

### Webhook Flow

```
GitHub push event
  │
  ▼
Platform Worker: POST /webhooks/github
  │
  ├─ Verify webhook signature (HMAC-SHA256)
  ├─ Look up project by repo (installation_id + repo full_name)
  ├─ Check branch filter (only build configured branches)
  ├─ Generate installation access token (GitHub App API, 1hr TTL)
  ├─ Insert build row into D1 (status: queued)
  └─ Poke BuildScheduler DO alarm
```

### D1 Schema (GitHub connection)

```sql
CREATE TABLE github_connections (
  project_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,  -- "owner/repo"
  branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX idx_github_repo ON github_connections(installation_id, repo_full_name);
```

---

## Cost

Per build on `standard-2` (1 vCPU, 6 GiB, 12 GB disk), 60s average:

| Resource         | Cost/build             | Free tier/month            |
| ---------------- | ---------------------- | -------------------------- |
| Container memory | 60s x 6 GiB = $0.0009  | 25 GiB-hr (~375 builds)    |
| Container CPU    | 60s x 1 vCPU = $0.0012 | 375 vCPU-min (~375 builds) |
| Container disk   | 60s x 12 GB ≈ $0       | 200 GB-hr                  |
| DO duration      | 60s x 128 MB ≈ $0.0001 | included                   |
| DO requests      | ~100 ≈ $0              | 1M free                    |
| Network egress   | ~15 MB ≈ $0.0004       | 1 TB                       |
| **Total**        | **~$0.0025**           | **~375 builds free**       |

At 10,000 builds/month: ~$25 in CF costs.

---

## Future Phases

These can be cleanly added without modifying the Phase 1 architecture:

### Build Caching (R2)

- Container saves/restores dependency and build caches to `{projectId}/build-cache/` in R2
- Auto-detect: `node_modules/.cache`, `.vite`, `pnpm-store`
- LRU eviction, 7-day TTL on last read
- Pure container-side change (add cache restore/save steps to build-agent)

### Preview Deploys

- Builds triggered by pull requests deploy to `pr-{n}--{slug}.void.app`
- Requires dispatch worker changes for PR URL routing
- Comment on PR with preview URL

### Git Clone Fallback

- Add `git` to container image, configurable per project
- For repos needing submodules or git history

### Monorepo Support

- Detect changed packages from commit diff
- Only build affected projects

### Custom Build Commands

- Override default `vite build` with user-specified command in project settings
- For non-Vite projects or custom build pipelines
