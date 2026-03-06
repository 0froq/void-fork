---
title: Versioned Deployments
status: draft
created: 2026-03-05
depends: []
---

# Versioned Deployments

## Summary

Replace atomic worker replacement with versioned worker scripts in the Workers for Platforms dispatch namespace. Each deployment gets its own worker (`user-{slug}-{deployId}`), traffic switches via KV routing update after validation. Enables safe migration execution, instant rollback, deployment pinning, and per-deployment log filtering.

## Motivation

The current deploy pipeline uploads a worker as `user-{slug}`, atomically replacing the previous version. This has several limitations:

1. **No rollback** — once deployed, the old code is gone. The only recovery is to redeploy.
2. **Migration risk** — migrations run externally (API executes SQL via CF REST API for D1). If migrations succeed but the worker deploy fails, the database is ahead of the code.
3. **No deployment pinning** — users can't switch between deployments (feature parity gap vs. Vercel/Netlify).
4. **Log attribution** — all logs share a single `scriptName`, making it impossible to filter by deployment.
5. **Postgres migrations** — with Hyperdrive/Postgres support (0052), the API can't run migrations via CF REST API. The worker itself needs to run migrations against its own Hyperdrive binding — which requires deploying the worker before running migrations, which requires versioned deploys to avoid serving traffic before migrations complete.

## Design

### Worker Naming

Each deployment produces a uniquely named worker script:

```
user-{slug}-{deployId}
```

`deployId` is the existing deployment record ID from the database. No new state to manage — the worker name is a deterministic function of the deployment record.

### Deploy Flow

```
1. Build + package (unchanged)
2. Provision bindings (unchanged)
3. Upload worker as user-{slug}-{deployId} to dispatch namespace
4. If manifest declares migrations:
   a. POST /__void/migrate to new worker via env.DISPATCH.get()
   b. Auth: HMAC via existing __VOID_PROXY_TOKEN binding
   c. Worker executes bundled migration SQL against its own DB binding
   d. Returns success/failure + per-migration status
   e. On failure: mark deployment failed, delete worker script, abort
5. Update KV routing entry: workerName -> user-{slug}-{deployId}
6. Update queue routing KV entries (same timing as main routing)
7. Traffic switches atomically
8. Mark deployment as active, set projects.activeDeploymentId
9. Cleanup: delete worker scripts beyond retention limit (oldest first)
```

For projects without a database, step 4 is skipped entirely (determined from the deploy manifest).

### Migration Endpoint

The framework registers `/__void/migrate` as a reserved internal route, handled before user routes.

- **Request:** `POST /__void/migrate` with HMAC token in header
- **Auth:** Validates against `__VOID_PROXY_TOKEN` (already injected into all user workers)
- **Execution:** Reads bundled `db/migrations/*.sql`, checks `_void_migrations` tracking table, runs pending migrations
- **Postgres:** Each migration file wrapped in a transaction (Postgres supports transactional DDL)
- **D1/SQLite:** Same behavior as today (no transactional DDL)
- **Response:** JSON with per-migration status:

```json
{
  "ok": true,
  "migrations": [
    { "name": "0001_initial.sql", "applied": true, "durationMs": 42 },
    { "name": "0002_add_posts.sql", "applied": true, "durationMs": 18 }
  ]
}
```

### Deploy Manifest Changes

Migration SQL is still shipped in the manifest for API-side observability (logging, dashboard display). The worker also bundles the SQL files for execution.

```ts
interface DeployManifest {
  version: number; // bump
  bindings: {
    d1?: string[];
    kv?: string[];
    r2?: string[];
    ai?: boolean;
    hyperdrive?: string[]; // e.g. ["HYPERDRIVE"]
  };
  migrations?: {
    dialect: "sqlite" | "postgresql";
    pending: number; // count of unapplied migrations
    // SQL files still included as FormData blobs for observability
  };
}
```

### KV Routing

No structural changes. The routing entry's `workerName` field points to the versioned name:

```ts
// Before
{ workerName: "user-myapp", limits: { ... } }

// After
{ workerName: "user-myapp-abc123", limits: { ... } }
```

Queue routing KV entries (`queue:{queueId}`) are updated at the same time as the main routing entry.

The dispatch worker requires no code changes — it already reads `workerName` dynamically from KV.

### Failure Handling

If migration fails:

1. Mark deployment as `failed` in DB
2. Delete the new worker script from dispatch namespace
3. Old deployment continues serving (KV routing unchanged)
4. Return migration error details to CLI/dashboard via deploy streaming

Postgres migrations are wrapped in transactions for atomicity. D1/SQLite behaves as today (no transactional DDL, partial application possible).

### Database Schema Changes

**Deployments table:**

- `status`: `deploying | failed | succeeded` — deployment outcome (unchanged semantically)
- `retained`: `boolean` — whether the worker script still exists in the dispatch namespace
- `migrations`: `text` (JSON array) — list of migration names applied at this deployment's point in time

**Projects table:**

- `activeDeploymentId`: FK to the deployment currently receiving traffic

The `retained` flag is set to `true` on successful deploy and `false` when the worker script is cleaned up (exceeds retention limit). `status` and `retained` are orthogonal: a `succeeded` deployment may or may not be `retained`.

### Retention Limits

| Plan      | Retained deployments |
| --------- | -------------------- |
| Free      | 1 (current only)     |
| Solo      | 5                    |
| Pro       | 25                   |
| Unlimited | unlimited            |

Cleanup runs at the tail end of a successful deploy. Deletes the oldest worker scripts beyond the limit via CF API. The active deployment is never deleted. Cost: $0.02/month per script in the dispatch namespace beyond the first 1,000 included.

### Rollback

Code-only rollback. The API updates KV routing to point to a previous `retained` deployment's worker name. Database schema is not rolled back.

If the target deployment's migration state differs from the current database state, the CLI warns:

```
$ void project rollback def456

Warning: The current database has 2 migrations applied after this deployment:
  - 0003_add_email_verified.sql
  - 0004_add_user_roles.sql

Rolling back will NOT revert these migrations. The older code will run
against the current schema.

Proceed? (y/n)
```

This is standard industry practice — down migrations are dangerous and most platforms (Vercel, Netlify) perform code-only rollback.

### CLI Commands

```bash
void project status                   # list deployments (shows status, retained, live)
void project rollback                 # interactive: pick from retained deployments
void project rollback {deployId}      # rollback to specific deployment
void project logs                     # logs for live deployment (default)
void project logs --deployment {id}   # logs for a specific deployment
```

`void project status` list output:

```
┌  void project status
│
│  id                type  status    source  commit   isr  deployed
│  dpl_bxyp34nxgnoe  void  live      ci      a259221  -    14h ago
│  dpl_lqky5iv0e1c4  void  retained  manual  cfaa3d0  -    1d ago
│  dpl_88cci6vfp45k  void  retained  ci      9f054d3  -    1d ago
│  dpl_lpk8sqnlrby6  void  evicted   ci      0fbb16f  -    1d ago
│  dpl_6i1frfi5o2ls  void  failed    manual  -        -    1d ago
│
└  kitchen-sink — 5 deployment(s)
```

- `live` means succeeded and currently serving traffic. Displayed in bold green.
- `retained` means succeeded and retained. Displayed in dimmed green.
- `evicted` means succeeded but cleaned up and no longer available for rollback. Displayed in gray.
- `failed` means a failed deployment attempt. Display in red.

Only `retained` deployments are valid rollback targets.

### Logging

With versioned worker names, `event.scriptName` in tail events becomes `user-{slug}-{deployId}`, embedding the deployment ID automatically.

**Tail worker changes:**

1. Parse `scriptName` to extract `slug` and `deployId`
2. Index by `slug` in Analytics Engine (project-level queries, same as today)
3. Store `deployId` in an additional blob field (deployment-level filtering)

**API query changes:**

- Project logs: `WHERE index1 = '{slug}'` (unchanged)
- Deployment logs: `WHERE index1 = '{slug}' AND blob6 = '{deployId}'`

**Live tailing (Durable Object):** Can be keyed by slug (all project logs) or by `slug-deployId` (deployment-specific).

**CLI defaults:** `void logs` shows logs for the active (live) deployment. `void logs --deployment {id}` filters to a specific deployment.

### Schema Overlap Window

During migration execution, the old worker is still serving traffic against the (now-modified) database. This is accepted as an inherent trade-off — the same window exists in the current architecture. Mitigations:

- Window is typically sub-second for simple migrations
- Framework already detects destructive migrations (`void:allow-destructive` pragma)
- Documentation recommends expand-and-contract pattern for breaking schema changes
- This is standard industry practice (GitHub, Stripe, most large-scale systems)

## What Changes Where

### Framework (`framework/`)

- Bundle `db/migrations/*.sql` into worker output at build time
- Register `/__void/migrate` handler in worker runtime
- Migration runner that executes SQL against the worker's own DB binding (D1 or Hyperdrive)
- `__VOID_PROXY_TOKEN` validation for the migration endpoint

### API (`packages/api`)

- Deploy route: upload with versioned worker name
- Deploy route: invoke `/__void/migrate` on new worker (conditional on manifest)
- Deploy route: cleanup old scripts beyond retention limit
- New endpoint: rollback (update KV routing to previous deployment)
- New endpoint: deployment pinning
- DB schema: add `retained`, `migrations` to deployments; add `activeDeploymentId` to projects

### Tail Worker (`packages/tail`)

- Parse versioned `scriptName` to extract slug + deployId
- Store deployId in Analytics Engine blob field

### Dispatch Worker (`packages/dispatch`)

- No changes. Already reads `workerName` dynamically from KV.

### Dashboard (`packages/dashboard`)

- Deployment list: show retained status, rollback action
- Deployment detail: show deployment-specific logs
- (Future scope, not blocking for v1)

### CLI (`framework/`)

- `void deployments` command
- `void rollback` command
- `void logs` defaults to live deployment, `--deployment {id}` flag

## Migration Path

This is a breaking change to the deploy pipeline but transparent to users. Existing projects:

1. First deploy after this change creates a versioned worker (`user-{slug}-{deployId}`)
2. The deploy flow detects and deletes the legacy `user-{slug}` script (no deployment ID suffix) from the dispatch namespace as part of the first versioned deploy
3. KV routing now points to the new versioned worker name

The legacy cleanup is automatic — on each deploy, after the new versioned worker is live, the API attempts to delete `user-{slug}` (the old unversioned name). This is a no-op if it doesn't exist, so it's safe to run unconditionally for a transition period.

No user action required.
