# @voidcloud/proxy

Unified proxy worker for AI inference metering and remote binding access. Hono-based CF Worker at `proxy.void.cloud`. Holds the real `AI` binding — user workers never get it directly. Also provides D1/KV/R2 proxy endpoints backed by CF REST APIs for local development with remote bindings.

## Why a proxy?

**AI metering:** Cloudflare charges our platform account for all AI inference across Workers for Platforms. If user workers had the `AI` binding, they could strip metering code and call `env.AI.run()` directly. The proxy ensures every inference call flows through our AI Gateway for tamper-proof logging.

**Remote bindings:** During local development, users may want to connect to their production/staging D1/KV/R2 resources instead of local miniflare. The proxy acts as an authenticated gateway to the CF REST APIs, resolving resource IDs from the platform database.

```
User worker (local dev)      Proxy (this worker)           CF REST API / AI Gateway
┌─────────────┐  HTTPS     ┌──────────────────┐  CF API  ┌────────────────────┐
│ ai.run()    │───────────▶│ /ai/*  → AI GW   │────────▶│ Workers AI         │
│ db.query()  │            │ /d1/*  → CF API  │────────▶│ D1 Database        │
│ kv.get()    │            │ /kv/*  → CF API  │────────▶│ KV Namespace       │
│ r2.get()    │            │ /r2/*  → CF API  │────────▶│ R2 Bucket          │
└─────────────┘            └──────────────────┘         └────────────────────┘
```

## Authentication

Two paths, determined by the presence of an `Authorization` header:

| Path                | When                          | Auth                                                                           |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| **Service binding** | Production (deployed to Void) | Trusted — no auth check. Project ID from request body.                         |
| **HTTPS**           | Local dev (`pnpm dev`)        | `Authorization: Bearer <jwt>` — JWT validated with `JWT_SECRET` (HMAC-SHA256). |

JWT payload: `{ sub: string, login: string, iat: number, exp: number }`

All endpoints require `projectId` in the JSON body. The proxy uses this to resolve the correct CF resource IDs from the platform database.

## Endpoints

### AI (`/ai/*`)

AI inference with usage-limit enforcement. Checks `ai-block:{projectId}` in KV before processing.

| Endpoint    | Body                                               | Response                  |
| ----------- | -------------------------------------------------- | ------------------------- |
| `POST /ai/` | `{ action, model?, inputs?, options?, projectId }` | JSON result or SSE stream |

Actions: `run` (inference), `models` (list models), `toMarkdown` (convert to markdown).

### D1 (`/d1/*`)

| Endpoint         | Body                                                     | Response                                                         |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /d1/query` | `{ binding, sql, params?, method?, projectId }`          | `{ results, meta: { changes, last_row_id, duration }, success }` |
| `POST /d1/batch` | `{ binding, statements: [{ sql, params? }], projectId }` | Array of D1Result                                                |

### KV (`/kv/*`)

| Endpoint          | Body                                                  | Response                           |
| ----------------- | ----------------------------------------------------- | ---------------------------------- |
| `POST /kv/get`    | `{ binding, key, projectId }`                         | Value (JSON) or `null`             |
| `POST /kv/put`    | `{ binding, key, value, expiration_ttl?, projectId }` | `{ success: true }`                |
| `POST /kv/delete` | `{ binding, key, projectId }`                         | `{ success: true }`                |
| `POST /kv/list`   | `{ binding, prefix?, limit?, cursor?, projectId }`    | `{ keys, list_complete, cursor? }` |

### R2 (`/r2/*`)

| Endpoint          | Body                                                | Response                                                |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `POST /r2/get`    | `{ binding, key, projectId }`                       | Binary body with metadata headers, or JSON `null`       |
| `POST /r2/put`    | `{ binding, key, value, content_type?, projectId }` | `{ key, size, etag, uploaded, version }`                |
| `POST /r2/delete` | `{ binding, key, projectId }`                       | `{ success: true }`                                     |
| `POST /r2/list`   | `{ binding, prefix?, limit?, cursor?, projectId }`  | `{ objects, truncated, cursor? }`                       |
| `POST /r2/head`   | `{ binding, key, projectId }`                       | `{ key, size, etag, uploaded, version }` or JSON `null` |

### Health Check

`GET /health` — returns `{ ok: true, bindings: { ai, kv, jwt, db } }`.

## Resource Resolution

The proxy resolves CF resource IDs from the platform database. Given a `projectId` and `binding` name, it looks up the project's resources in D1 to find the real CF resource IDs (database ID, KV namespace ID, R2 bucket name). This ensures user workers never need to know or manage CF resource IDs directly.

## Error Handling

- AI binding errors return `502` with `{ error: "<message>" }`.
- CF REST API errors return `502` with `{ error: "<context>", status: <upstream_status> }`.
- Missing or unresolvable bindings return `404`.
- All error responses include CORS headers.
- CORS preflight (`OPTIONS`) returns `204`.

## Source Layout

```
src/
  index.ts          # Hono app — CORS, auth middleware, route mounting
  ai.ts             # AI inference endpoints
  d1.ts             # D1 proxy endpoints (query, batch)
  kv.ts             # KV proxy endpoints (get, put, delete, list)
  r2.ts             # R2 proxy endpoints (get, put, delete, list, head)
  resolve.ts        # Resource ID resolution from platform DB
  types.ts          # Shared types (ProxyEnv, JwtPayload)
test/
  unit/
    proxy.test.ts   # Auth, CORS, AI actions, streaming
    d1.test.ts      # D1 query/batch endpoints
    kv.test.ts      # KV get/put/delete/list endpoints
    r2.test.ts      # R2 get/put/delete/list/head endpoints
    resolve.test.ts # Resource resolution logic
```

## Bindings

| Binding         | Type       | Purpose                                                           |
| --------------- | ---------- | ----------------------------------------------------------------- |
| `AI`            | Workers AI | The real AI binding — inference calls                             |
| `JWT_SECRET`    | Secret     | Shared HMAC-SHA256 secret for JWT verification (same as platform) |
| `CF_ACCOUNT_ID` | Secret     | Cloudflare account ID for REST API calls                          |
| `CF_API_TOKEN`  | Secret     | Cloudflare API token for D1/KV/R2 REST API calls                  |
| `ROUTING`       | KV         | AI usage limit checks (`ai-block:{projectId}`)                    |
| `DB`            | D1         | Platform database for resource ID resolution                      |

## Deployment

```
pnpm -C packages/proxy deploy              # Production (proxy.void.cloud)
pnpm -C packages/proxy deploy --env staging # Staging (proxy.staging.void.cloud)
```

Deployed as part of the root `pnpm run deploy` / `pnpm run deploy:staging` scripts.

## Tests

| Test file                   | Covers                                                         |
| --------------------------- | -------------------------------------------------------------- |
| `test/unit/proxy.test.ts`   | CORS, method validation, JWT auth, service binding, AI actions |
| `test/unit/d1.test.ts`      | D1 query, batch, error handling                                |
| `test/unit/kv.test.ts`      | KV get, put, delete, list, error handling                      |
| `test/unit/r2.test.ts`      | R2 get, put, delete, list, head, error handling                |
| `test/unit/resolve.test.ts` | Resource ID resolution from platform DB                        |
