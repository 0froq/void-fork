---
outline: deep
---

# API Reference

All public exports of the `vite-cloud` package.

## Plugin

### `viteCloud()`

The default export. Returns an array of Vite plugins that set up file-based routing, migration support, and the Cloudflare Workers runtime. Takes no arguments — all configuration is read from [`vite-cloud.json`](./config.md).

```ts
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

## Handlers

Imported from `"vite-cloud"` or `"vite-cloud/handler"`.

### `defineHandler(handler)`

Wraps a route handler function. The handler receives a [`CloudContext`](#cloudcontext) and can return a plain value (auto-converted to a Response) or use the Hono `c.json()` / `c.text()` APIs directly.

```ts
import { defineHandler } from "vite-cloud";

export const GET = defineHandler((c) => {
  return { message: "hello" };
});
```

**Signature:**

```ts
function defineHandler<R>(handler: (c: CloudContext) => R): TypedHandler<{}, R>;
```

### `defineHandler(middleware..., handler)`

Composes up to 5 per-route middleware with a final handler. Middleware runs in order before the handler.

```ts
export const GET = defineHandler(authMiddleware, rateLimiter, (c) => {
  return { ok: true };
});
```

### `defineHandler.withValidator(validators)`

Creates a handler with input validation using any [Standard Schema](https://github.com/standard-schema/standard-schema) compatible library (zod, valibot, arktype, etc.). Returns a curried function that accepts the handler.

Validated input is passed as the second argument to the handler.

```ts
import { defineHandler } from "vite-cloud";
import * as v from "valibot";

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})((c, { body }) => {
  return { received: body.name };
});
```

**Signature:**

```ts
function withValidator<V extends ValidatorSlots>(
  validators: V,
): <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R) => TypedHandler<V, R>;
```

**Type: `ValidatorSlots`**

```ts
interface ValidatorSlots {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}
```

**Type: `HandlerInput<V>`**

The inferred output types of each validator slot. For a `ValidatorSlots` with `body` and `query`, the input object has `{ body: ..., query: ... }` with types inferred from the schema output.

### `defineMiddleware(handler)`

Type-safe wrapper for Hono middleware. At runtime, returns the function unchanged.

```ts
import { defineMiddleware } from "vite-cloud";

export default defineMiddleware(async (c, next) => {
  console.log(`${c.req.method} ${c.req.path}`);
  await next();
});
```

**Signature:**

```ts
function defineMiddleware(handler: MiddlewareHandler<CloudEnv>): MiddlewareHandler<CloudEnv>;
```

### `defineJob(handler)`

Wraps a Cloudflare [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) with type inference.

```ts
import { defineJob } from "vite-cloud";

export default defineJob(async (controller, env, ctx) => {
  const { results } = await env.DB.prepare("SELECT * FROM stale").all();
  // ...
});
```

**Signature:**

```ts
function defineJob(
  handler: (
    controller: ScheduledController,
    env: CloudEnv["Bindings"],
    ctx: ExecutionContext,
  ) => unknown | Promise<unknown>,
): JobFn;
```

### `defineRender(handler)`

Wraps an SSR render entry. The second argument provides pre-built `<head>` and `<body>` asset tags for injecting client scripts and styles.

```ts
import { defineRender } from "vite-cloud";
import { renderToString } from "react-dom/server";

export default defineRender((c, assetTags) => {
  const html = renderToString(<App />);
  return c.html(`<!DOCTYPE html>
    <html><head>${assetTags.head}</head>
    <body><div id="root">${html}</div>${assetTags.body}</body></html>`);
});
```

**Signature:**

```ts
function defineRender(
  handler: (c: CloudContext, assetTags: RenderAssetTags) => Response | Promise<Response>,
): RenderFn;
```

**Type: `RenderAssetTags`**

```ts
interface RenderAssetTags {
  head: string; // Script and style tags for <head>
  body: string; // Script tags for before </body>
}
```

## Auth

Imported from `"vite-cloud"` or `"vite-cloud/auth"`.

### `requireAuth(c)`

Extracts the authenticated user from the request context. Throws a 401 `HTTPException` if no session is present.

```ts
import { defineHandler } from "vite-cloud";
import { requireAuth } from "vite-cloud/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

**Signature:**

```ts
function requireAuth(c: CloudContext): AuthUser;
```

**Type: `AuthUser`**

```ts
interface AuthUser {
  id: string;
  provider: string; // "email", "github", or "google"
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}
```

## Typed Client

Imported from `"vite-cloud/client"`.

### `fetch(path, options?)`

Type-safe fetch client for calling your API routes from client code, built on top of [ofetch](https://github.com/unjs/ofetch). Route paths and return types are inferred from the generated `RouteMap`.

```ts
import { fetch } from "vite-cloud/client";

// Types are fully inferred from your route handlers
const users = await fetch("/api/users");
const user = await fetch("/api/users/:id", {
  params: { id: "1" },
});
```

**Signature:**

```ts
function fetch<P extends keyof RouteMap, M extends MethodsOf<P>>(
  path: P,
  options?: FetchOptions<P, M>,
): Promise<OutputOf<P, M>>;
```

**Options:**

| Option    | Type                     | Description                                                |
| --------- | ------------------------ | ---------------------------------------------------------- |
| `method`  | `string`                 | HTTP method. Defaults to `"GET"`.                          |
| `body`    | `unknown`                | Request body (auto-serialized as JSON).                    |
| `query`   | `Record<string, string>` | Query string parameters.                                   |
| `params`  | `Record<string, string>` | URL path parameters (`:id` segments).                      |
| `headers` | `HeadersInit`            | Additional request headers.                                |
| `signal`  | `AbortSignal`            | Abort signal.                                              |
| `baseURL` | `string`                 | Base URL prepended to the path. Useful for external calls. |
| `retry`   | `number`                 | Number of retry attempts (ofetch default: 1 for GET).      |
| `timeout` | `number`                 | Request timeout in milliseconds.                           |

Returns the parsed JSON response body, or `undefined` for 204 responses. Throws `FetchError` on non-2xx responses.

### `FetchError`

Error class thrown by `fetch` on non-2xx responses.

```ts
import { fetch, FetchError } from "vite-cloud/client";

try {
  await fetch("/api/users/:id", { params: { id: "999" } });
} catch (e) {
  if (e instanceof FetchError) {
    console.log(e.status); // 404
    console.log(e.response); // raw Response
  }
}
```

**Properties:**

| Property   | Type       | Description                          |
| ---------- | ---------- | ------------------------------------ |
| `status`   | `number`   | HTTP status code.                    |
| `response` | `Response` | The raw `Response` object.           |
| `data`     | `unknown`  | Parsed response body (if available). |

### Differences from Native `fetch`

The typed client is built on [ofetch](https://github.com/unjs/ofetch) with a typed route layer on top. Key differences from native `fetch`:

| Behavior               | Native `fetch`                                       | `vite-cloud/client` `fetch`                                                                                               |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Return type**        | `Promise<Response>` — you call `.json()` yourself    | `Promise<T>` — auto-parses JSON, returns the typed result directly (`undefined` for 204)                                  |
| **Error handling**     | Resolves on any HTTP status; you check `response.ok` | Throws `FetchError` on non-2xx responses                                                                                  |
| **URL construction**   | Raw URL string                                       | Route path with `:param` interpolation from `options.params` + query string from `options.query`                          |
| **Body serialization** | Manual `JSON.stringify()` + `Content-Type` header    | Auto-serializes `options.body` as JSON and sets `Content-Type: application/json`                                          |
| **Type safety**        | Accepts any URL/method                               | Constrains paths to `RouteMap` keys and methods to those defined per route — invalid combinations are compile-time errors |
| **Retry**              | None                                                 | Auto-retries on 408, 429, and 5xx (configurable via `retry` option)                                                       |
| **Timeout**            | None                                                 | Configurable via `timeout` option                                                                                         |

`headers` and `signal` are passed through to the underlying fetch unchanged.

## Types

### `CloudContext`

Hono `Context` pre-typed with [`CloudEnv`](#cloudenv). This is the type of the `c` parameter in all route handlers and middleware.

```ts
import type { CloudContext } from "vite-cloud";
```

### `CloudEnv`

Hono environment type for Vite Cloud workers. Extends Hono's `Env` with Cloudflare bindings and session variables.

```ts
interface CloudEnv extends Env {
  Bindings: {
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AUTH_KV: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    user: AuthUser | null;
  };
}
```

### `TypedHandler<V, R>`

The return type of `defineHandler`. Carries phantom types for validators (`V`) and return type (`R`) used by the codegen to produce typed routes.

```ts
interface TypedHandler<V extends ValidatorSlots = {}, R = unknown> {
  (c: CloudContext): Promise<Response> | Response | unknown;
  readonly __validators: V; // type-level only
  readonly __output: R; // type-level only
}
```

### `RouteMap`

Empty stub interface augmented at build time by the generated `.vite-cloud/routes.d.ts`. Contains the full type information for all routes, methods, inputs, and outputs — used by the typed `fetch` client.

```ts
import type { RouteMap } from "vite-cloud/routes";
```

## Environment Types

Importing `"vite-cloud/env"` provides global Cloudflare environment types:

```ts
/// <reference types="vite-cloud/env" />
```

Declares the `Cloudflare.Env` namespace with `DB: D1Database`, `KV: KVNamespace`, and `STORAGE: R2Bucket`.

## Subpath Exports

| Import path            | Contents                                                                |
| ---------------------- | ----------------------------------------------------------------------- |
| `vite-cloud`           | Plugin default export + all handler/type re-exports                     |
| `vite-cloud/handler`   | `defineHandler`, `defineMiddleware`, `defineJob`, `defineRender`, types |
| `vite-cloud/auth`      | `requireAuth`, `AuthUser`                                               |
| `vite-cloud/client`    | `fetch`, `FetchError`                                                   |
| `vite-cloud/response`  | `convertReturnValue`                                                    |
| `vite-cloud/validator` | `runValidation`, `ValidatorSlots`, `HandlerInput`                       |
| `vite-cloud/routes`    | `RouteMap` stub (types only)                                            |
| `vite-cloud/env`       | Global Cloudflare env types (types only)                                |
