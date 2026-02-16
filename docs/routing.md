# Routing

Vite Cloud routing runs on a generated Hono app.

It uses a file-system router from `routes/` plus optional global middleware from `middleware/`.

If `src/main.ssr.ts` exists, route handlers still run first and SSR is used as a fallback for unmatched non-API requests via `render(c, assetTags)`.

## Route files

Create route handlers in `routes/**/*.ts` (`.mts`, `.js`, `.mjs` also supported).

Example:

```ts
// routes/api/users/[id].get.ts
import { defineHandler } from "vite-cloud";

export default defineHandler(async (c) => {
  const id = c.req.param("id");
  return { id };
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

### Per-route middleware

`defineHandler` accepts one or more middleware before the final handler:

```ts
defineHandler(middleware1, middleware2, handler);
```

Middleware runs in order. Each middleware can short-circuit (return a response without calling `next()`) or post-process (modify the response after `await next()`). Both `defineMiddleware`-wrapped functions and raw Hono `MiddlewareHandler` functions are accepted.

```ts
// routes/api/admin/stats.get.ts
import { defineHandler } from "vite-cloud";
import { bearerAuth } from "hono/bearer-auth";

const requireAdmin = async (c, next) => {
  const user = c.get("user");
  if (!user?.isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
};

export default defineHandler(bearerAuth({ token: "secret" }), requireAdmin, (c) => {
  return { stats: "..." };
});
```

Up to 5 middleware can be passed before the handler, with full type inference for each position.

## Filename conventions

Rules are applied to path segments relative to `routes/`:

1. Strip extension (`.ts`, `.mts`, `.js`, `.mjs`)
2. Optional method suffix: `.get`, `.post`, `.put`, `.delete`, `.patch`
3. Default method is `*` (all methods)
4. Strip trailing `index`
5. Remove route-group directories like `(group)`
6. Convert params:

- `[id]` -> `:id`
- `[...rest]` -> `**:rest`
- `[...]` -> `**`

Examples:

- `routes/index.ts` -> `* /`
- `routes/api/hello.get.ts` -> `GET /api/hello`
- `routes/api/users/[id].ts` -> `* /api/users/:id`
- `routes/docs/[...slug].get.ts` -> `GET /docs/**:slug`

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
// routes/api/download.get.ts
import { defineHandler } from "vite-cloud";
import { stream } from "hono/streaming";

export default defineHandler((c) => {
  return stream(c, async (stream) => {
    await stream.write("chunk 1");
    await stream.write("chunk 2");
  });
});
```

```ts
// routes/api/data.get.ts
import { defineHandler } from "vite-cloud";

export default defineHandler((c) => {
  // Set headers, status, cookies directly
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

### Per-route middleware

Pass Hono middleware directly to `defineHandler` to apply it to a single route:

```ts
// routes/api/webhooks/stripe.post.ts
import { defineHandler } from "vite-cloud";
import { bearerAuth } from "hono/bearer-auth";

export default defineHandler(bearerAuth({ token: "webhook-secret" }), async (c) => {
  const body = await c.req.json();
  return { received: true };
});
```

This works with any Hono-compatible middleware — built-in, third-party, or custom:

```ts
// routes/api/protected.get.ts
import { defineHandler, defineMiddleware } from "vite-cloud";
import { cors } from "hono/cors";
import { rateLimiter } from "hono-rate-limiter";

const requireAuth = defineMiddleware(async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthorized" }, 401);
  await next();
});

export default defineHandler(
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
import { validator } from "hono/validator";
import { HTTPException } from "hono/http-exception";

// Throw typed HTTP errors
throw new HTTPException(404, { message: "User not found" });
```

For the full list of built-in middleware, see the [Hono documentation](https://hono.dev/docs/middleware/builtin).
