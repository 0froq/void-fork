# Routing

Vite Cloud routing runs on a generated Hono app.

It uses a file-system router from `routes/` plus optional global middleware from `middleware/`.

If `src/main.ssr.ts` exists, route handlers still run first and SSR is used as a fallback for unmatched non-API requests via `render(c, assetTags)`.

## Route files

Create route handlers in `routes/**/*.ts` (`.mts`, `.js`, `.mjs` also supported).

Each file maps to one URL path. Export named HTTP method constants (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `HEAD`) to handle specific methods:

```ts
// routes/api/hello.ts  →  GET /api/hello
import { defineHandler } from "vite-cloud";

export const GET = defineHandler((c) => {
  return { message: "Hello!", timestamp: Date.now() };
});
```

A file can export multiple methods:

```ts
// routes/api/users/index.ts  →  GET + POST /api/users
import { defineHandler } from "vite-cloud";

export const GET = defineHandler(async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users").all();
  return results;
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json();
  await c.env.DB.prepare("INSERT INTO users (name) VALUES (?)").bind(body.name).run();
  return { created: true };
});
```

## `defineHandler`

`defineHandler` wraps a route handler with optional per-route middleware.

### Basic usage

```ts
defineHandler(handler);
```

Handler signature (Hono context):

```ts
(c: CloudContext) => unknown | Promise<unknown>;
```

`CloudContext` is a Hono `Context` with typed Cloudflare bindings on `c.env` (see [Cloudflare Env](./cloudflare-env.md)).

Return values:

- `Response`: returned as-is
- `null`/`undefined`: `204 No Content`
- `string`: `text/html; charset=utf-8`
- object/array/number/boolean: JSON response

You can also call Hono response helpers directly (`c.json()`, `c.text()`, etc.).

### Input validation

`defineHandler.withValidator()` adds input validation using any [Standard Schema](https://standardschema.dev/)-compatible library — Zod, Valibot, ArkType, and others. Validators can be specified for `body`, `query`, and/or `params`:

```ts
// routes/api/users/index.ts
import * as v from "valibot";
import { defineHandler } from "vite-cloud";

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})(async (c, { body }) => {
  // body is typed as { name: string; email: string }
  await c.env.DB.prepare("INSERT INTO users (name, email) VALUES (?, ?)")
    .bind(body.name, body.email)
    .run();
  return { created: true };
});
```

You can validate multiple slots at once:

```ts
// routes/api/users/[id].ts
import { z } from "zod";
import { defineHandler } from "vite-cloud";

export const PUT = defineHandler.withValidator({
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string(), email: z.string().email() }),
})(async (c, { params, body }) => {
  await c.env.DB.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?")
    .bind(body.name, body.email, params.id)
    .run();
  return { updated: true };
});
```

When validation fails, a `400` response is returned with structured error details:

```json
{
  "error": "Validation failed",
  "issues": [
    {
      "slot": "body",
      "issues": [{ "message": "Invalid email", "path": "email" }]
    }
  ]
}
```

No extra dependencies are required — Vite Cloud inlines the Standard Schema V1 types. You only need your chosen schema library.

### Per-route middleware

`defineHandler` accepts one or more middleware before the final handler:

```ts
defineHandler(middleware1, middleware2, handler);
```

Middleware runs in order. Each middleware can short-circuit (return a response without calling `next()`) or post-process (modify the response after `await next()`). Both `defineMiddleware`-wrapped functions and raw Hono `MiddlewareHandler` functions are accepted.

```ts
// routes/api/admin/stats.ts
import { defineHandler } from "vite-cloud";
import { bearerAuth } from "hono/bearer-auth";

const requireAdmin = async (c, next) => {
  const user = c.get("user");
  if (!user?.isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
};

export const GET = defineHandler(bearerAuth({ token: "secret" }), requireAdmin, (c) => {
  return { stats: "..." };
});
```

Up to 5 middleware can be passed before the handler, with full type inference for each position.

## Filename conventions

Rules are applied to path segments relative to `routes/`:

1. Strip extension (`.ts`, `.mts`, `.js`, `.mjs`)
2. Optional env suffix: `.dev`, `.prod` (include route only in that environment)
3. Strip trailing `index`
4. Remove route-group directories like `(group)`
5. Convert params:

- `[id]` -> `:id`
- `[...rest]` -> `**:rest`
- `[...]` -> `**`

HTTP methods are determined by the **named exports** in each file, not by the filename.

Examples:

| File                       | Route                    |
| -------------------------- | ------------------------ |
| `routes/index.ts`          | `/`                      |
| `routes/api/hello.ts`      | `/api/hello`             |
| `routes/api/users/[id].ts` | `/api/users/:id`         |
| `routes/docs/[...slug].ts` | `/docs/**:slug`          |
| `routes/debug.dev.ts`      | `/debug` (dev only)      |
| `routes/(admin)/users.ts`  | `/users` (group ignored) |

Files or directories starting with `_` are ignored.

## Middleware

There are two ways to apply middleware:

- **Global middleware** — runs on every request. Place files in `middleware/`.
- **Per-route middleware** — runs on a single route. Pass to `defineHandler()` (see above).

### Global middleware

Place global middleware in `middleware/`.

Use numeric prefixes for ordering:

- `middleware/01.logger.ts`
- `middleware/02.auth.ts`

```ts
import { defineMiddleware } from "vite-cloud";

export default defineMiddleware(async (c, next) => {
  console.log(c.req.method, c.req.path);
  await next();
});
```

`defineMiddleware` uses Hono middleware semantics: `(c, next) => Promise<void> | void`.

## Type safety

Vite Cloud generates end-to-end type safety from your route handlers to your client code.

### How it works

When `vite dev` or `vite build` runs, the routing plugin:

1. Scans `routes/` for files with named HTTP method exports
2. Generates `.vite-cloud/routes.d.ts` — a TypeScript declaration file that maps every route to its input and output types
3. The generated types use `typeof import(...)` to resolve types directly from your handler source code — no manual type annotations needed

The generated `RouteMap` is used by the typed `fetch` client to provide autocomplete and type checking for paths, methods, request bodies, and response types.

### Setting up `tsconfig.json`

To enable type discovery, extend the generated tsconfig in your project's `tsconfig.json`:

```json
{
  "extends": "./.vite-cloud/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "types": ["vite-cloud/env"]
  },
  "include": ["src", "routes", "middleware"]
}
```

The `"extends"` line is the key part. The generated `.vite-cloud/tsconfig.json` includes `routes.d.ts` via its `files` field, which TypeScript inherits automatically. You do not need to add `.vite-cloud` to your `include` array.

> **Note:** The `.vite-cloud/tsconfig.json` and `routes.d.ts` files are generated when the dev server starts or when you build. Run `vite dev` or `vite build` at least once to generate them.

### Typed `fetch` client

Import `fetch` from `vite-cloud/client` to get a fully typed API client:

```ts
import { fetch } from "vite-cloud/client";

// Return type inferred from your GET handler
const users = await fetch("/api/users");

// Method + body type-checked against your POST handler's validator
await fetch("/api/users", {
  method: "POST",
  body: { name: "Alice", email: "alice@example.com" },
});

// Dynamic params interpolated from the path pattern
const user = await fetch("/api/users/:id", {
  params: { id: "42" },
});
```

The client provides:

- **Path autocomplete** — only paths defined in `routes/` are accepted
- **Method validation** — only methods exported from the route file are allowed
- **Input type checking** — `body`, `query`, and `params` are typed based on validators
- **Output type inference** — the return type matches what your handler returns, after JSON serialization (e.g. `Date` becomes `string`, functions are stripped)

Under the hood, `fetch` calls `globalThis.fetch` with JSON serialization, path interpolation, and query string construction. Non-OK responses throw a `FetchError` with the `response` and `status` attached.

### What gets serialized

The type system models JSON serialization. The `Serialize<T>` type transform applied to handler return types:

| Source type                       | Serialized type                                           |
| --------------------------------- | --------------------------------------------------------- |
| `string`, `number`, `boolean`     | unchanged                                                 |
| `Date`                            | `string`                                                  |
| `Response`                        | excluded (passed through at runtime, not in typed output) |
| `bigint`, `Function`, `undefined` | excluded                                                  |
| `Array<T>`                        | `Array<Serialize<T>>`                                     |
| `{ key: T }`                      | `{ key: Serialize<T> }` (function-valued keys stripped)   |

### Validators and input types

When you use `defineHandler.withValidator()`, the validator schemas become part of the route's input type in the `RouteMap`. The typed client enforces these at the call site:

```ts
// In routes/api/search.ts:
export const GET = defineHandler.withValidator({
  query: z.object({ q: z.string(), page: z.string().optional() }),
})((c, { query }) => {
  return { results: [], query: query.q };
});

// In client code:
const data = await fetch("/api/search", {
  query: { q: "hello" }, // ✓ type-checked
});
// data is typed as { results: never[]; query: string }
```

Routes without validators have an empty input type — no `body`, `query`, or `params` are required.

## Using the Hono ecosystem

Vite Cloud handlers run on Hono, and `hono` is a direct dependency of your project. You can import from any `hono/*` subpath — built-in middleware, helpers, and third-party Hono packages all work out of the box.

### Built-in middleware

Use Hono's built-in middleware in your global middleware files:

```ts
// middleware/01.cors.ts
import { defineMiddleware } from "vite-cloud";
import { cors } from "hono/cors";

export default defineMiddleware(cors({ origin: "https://example.com" }));
```

```ts
// middleware/02.cache.ts
import { defineMiddleware } from "vite-cloud";
import { cache } from "hono/cache";

export default defineMiddleware(cache({ cacheName: "my-app", cacheControl: "max-age=3600" }));
```

### Response helpers

Hono's context helpers are available on `c` in every handler:

```ts
// routes/api/download.ts
import { defineHandler } from "vite-cloud";
import { stream } from "hono/streaming";

export const GET = defineHandler((c) => {
  return stream(c, async (stream) => {
    await stream.write("chunk 1");
    await stream.write("chunk 2");
  });
});
```

```ts
// routes/api/data.ts
import { defineHandler } from "vite-cloud";

export const GET = defineHandler((c) => {
  c.header("X-Custom", "value");
  c.status(201);
  return c.json({ created: true });
});
```

### Third-party Hono middleware

Any `hono/*` or `@hono/*` package works. Install and use directly:

```ts
// middleware/01.rate-limit.ts
import { defineMiddleware } from "vite-cloud";
import { rateLimiter } from "hono-rate-limiter";

export default defineMiddleware(rateLimiter({ windowMs: 60_000, limit: 100 }));
```

### Per-route Hono middleware

Pass Hono middleware directly to `defineHandler` to apply it to a single route:

```ts
// routes/api/webhooks/stripe.ts
import { defineHandler } from "vite-cloud";
import { bearerAuth } from "hono/bearer-auth";

export const POST = defineHandler(bearerAuth({ token: "webhook-secret" }), async (c) => {
  const body = await c.req.json();
  return { received: true };
});
```

This works with any Hono-compatible middleware — built-in, third-party, or custom:

```ts
// routes/api/protected.ts
import { defineHandler, defineMiddleware } from "vite-cloud";
import { cors } from "hono/cors";
import { rateLimiter } from "hono-rate-limiter";

const requireAuth = defineMiddleware(async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthorized" }, 401);
  await next();
});

export const GET = defineHandler(
  cors({ origin: "https://example.com" }),
  rateLimiter({ windowMs: 60_000, limit: 100 }),
  requireAuth,
  (c) => {
    return { data: "protected" };
  },
);
```

### Hono utilities

Hono's standalone helpers work anywhere:

```ts
import { HTTPException } from "hono/http-exception";

// Throw typed HTTP errors
throw new HTTPException(404, { message: "User not found" });
```

For the full list of built-in middleware, see the [Hono documentation](https://hono.dev/docs/middleware/builtin).
