# @voidcloud/ai-proxy

AI inference proxy for metered Workers AI billing. CF Worker using plain `fetch` handler (no framework). Holds the real `AI` binding — user workers never get it directly.

## Why a proxy?

Cloudflare charges our platform account for all AI inference across Workers for Platforms. If user workers had the `AI` binding, they could strip metering code and call `env.AI.run()` directly. The proxy ensures every inference call flows through our AI Gateway for tamper-proof logging.

```
User worker                 AI Proxy (this worker)       AI Gateway           CF Inference
┌─────────────┐  service  ┌──────────────────┐  gateway ┌────────────┐      ┌───────────┐
│ ai.run()    │──binding─▶│ inject gateway   │────────▶│ log tokens │─────▶│ Workers   │
│             │           │ config + project │         │ track cost │      │ AI        │
│ no AI bind  │           │ metadata         │         │ cache hits │      │           │
└─────────────┘           └──────────────────┘         └────────────┘      └───────────┘
```

## Request Format

All requests are `POST` with JSON body:

```ts
interface ProxyRequest {
  action: "run" | "models" | "toMarkdown";
  model?: string; // required for "run"
  inputs?: unknown; // model inputs (prompt, messages, etc.)
  options?: Record<string, unknown>; // passed through to AI.run()
  projectId: string; // always required
}
```

The proxy injects `gateway: { id: "void", metadata: { projectId } }` into every `AI.run()` call. User-supplied `options` are merged (gateway config cannot be overridden).

## Authentication

Two paths, determined by the presence of an `Authorization` header:

| Path                | When                          | Auth                                                                                                                                  |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Service binding** | Production (deployed to Void) | Trusted — no auth check. Project ID from request body.                                                                                |
| **HTTPS**           | Local dev (`pnpm dev`)        | `Authorization: Bearer <jwt>` — JWT validated with shared `JWT_SECRET` (HMAC-SHA256, same as platform). Project ID from request body. |

JWT payload: `{ sub: string, login: string, iat: number, exp: number }`

## Actions

### `run`

Calls `env.AI.run(model, inputs, options)` with gateway metadata injected.

- **Streaming:** When `inputs.stream` is `true`, returns `Response` with `content-type: text/event-stream` and `cache-control: no-cache`.
- **Non-streaming:** Returns `Response.json(result)`.
- Returns `400` if `model` is missing.

### `models`

Calls `env.AI.models(inputs)`. Returns JSON array of available models.

### `toMarkdown`

Calls `env.AI.toMarkdown(inputs, options)`. Returns JSON with converted markdown.

## Error Handling

- AI binding errors return `502` with `{ error: "<message>" }`.
- All error responses include CORS headers.
- CORS preflight (`OPTIONS`) returns `204`.

## Source Layout

```
src/
  index.ts          # Fetch handler — auth, action dispatch, gateway injection, JWT verification
test/
  unit/
    proxy.test.ts   # 19 tests — CORS, auth, actions, streaming, errors
```

## Bindings

| Binding      | Type       | Purpose                                                           |
| ------------ | ---------- | ----------------------------------------------------------------- |
| `AI`         | Workers AI | The real AI binding — inference calls                             |
| `JWT_SECRET` | Secret     | Shared HMAC-SHA256 secret for JWT verification (same as platform) |

## Deployment

```
pnpm -C packages/ai-proxy deploy              # Production (ai-proxy.void.cloud)
pnpm -C packages/ai-proxy deploy --env staging # Staging (ai-proxy.staging.void.cloud)
```

Deployed as part of the root `pnpm run deploy` / `pnpm run deploy:staging` scripts. Must deploy before dispatch/platform since user workers depend on the `__AI_PROXY` service binding.

## Tests

| Test file                 | Covers                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/proxy.test.ts` | CORS, method validation, JWT auth (valid/expired/bad secret/malformed), service binding path, all 3 actions, streaming, error handling (19 tests) |
