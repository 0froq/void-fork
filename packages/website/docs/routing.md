# Routing

Vite Cloud uses file-based routing powered by [Hono](https://hono.dev). Drop files in `routes/` and they become endpoints. Add global middleware in `middleware/`.

## Route Files

Create route handlers in `routes/**/*.ts`. Each file maps to a URL path based on its location in the filesystem:

| File                        | URL              |
| --------------------------- | ---------------- |
| `routes/index.ts`           | `/`              |
| `routes/api/hello.ts`       | `/api/hello`     |
| `routes/api/users/index.ts` | `/api/users`     |
| `routes/api/users/[id].ts`  | `/api/users/:id` |
| `routes/docs/[...slug].ts`  | `/docs/*`        |

Dynamic segments use brackets: `[id]` becomes a route parameter, `[...slug]` becomes a catch-all. Files or directories starting with `_` are ignored. Directories wrapped in parentheses like `(admin)` are route groups — they organize files without affecting the URL.

You can add a `.dev` or `.prod` suffix before the extension (e.g. `debug.dev.ts`) to include a route only in that environment.

Each file exports named HTTP method constants to handle specific methods:

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

`defineHandler` wraps a route handler function:

```ts
import { defineHandler } from "vite-cloud";

export const GET = defineHandler((c) => {
  return { data: "hello" };
});
```

The handler receives a Hono `Context` with typed Cloudflare bindings on `c.env` (see [Cloudflare](./cloudflare.md)). You can use the full Hono API (`c.json()`, `c.text()`, `c.header()`, etc.).

Return values are automatically converted:

- **object/array/number/boolean** → JSON response
- **`string`** → `text/html; charset=utf-8`
- **`null`/`undefined`** → `204 No Content`
- **`Response`** → returned as-is

## Validation

`defineHandler.withValidator()` adds input validation using any [Standard Schema](https://standardschema.dev/)-compatible library (Zod, Valibot, ArkType, etc.). Validators can be specified for `body`, `query`, and/or `params`:

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

No extra dependencies are required — Vite Cloud inlines the Standard Schema types. You only need your chosen schema library.

Validator schemas also power the [typed fetch client](./type-safety.md#typed-fetch-client) — `body`, `query`, and `params` types are enforced at the call site.

## Middleware

There are two ways to apply middleware:

- **Global middleware** — runs on every request. Place files in `middleware/`.
- **Per-route middleware** — runs on a single route. Pass to `defineHandler()`.

### Global middleware

Place global middleware in `middleware/`. Use numeric prefixes for ordering:

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

### Per-route middleware

Pass one or more middleware to `defineHandler` before the final handler:

```ts
defineHandler(middleware1, middleware2, handler);
```

Middleware runs in order. Each can short-circuit (return a response without calling `next()`) or post-process (modify the response after `await next()`). Both `defineMiddleware`-wrapped functions and raw Hono `MiddlewareHandler` functions are accepted.

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

## Using the Hono Ecosystem

Vite Cloud handlers run on Hono, and `hono` is a direct dependency of your project. You can import from any `hono/*` subpath — built-in middleware, helpers, and third-party Hono packages all work out of the box.

### Built-in middleware

Use Hono's built-in middleware in your global middleware files or per-route:

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

```ts
// routes/api/webhooks/stripe.ts — per-route usage
import { defineHandler } from "vite-cloud";
import { bearerAuth } from "hono/bearer-auth";

export const POST = defineHandler(bearerAuth({ token: "webhook-secret" }), async (c) => {
  const body = await c.req.json();
  return { received: true };
});
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

### Third-party middleware

Any `hono/*` or `@hono/*` package works. Install and use directly:

```ts
// middleware/01.rate-limit.ts
import { defineMiddleware } from "vite-cloud";
import { rateLimiter } from "hono-rate-limiter";

export default defineMiddleware(rateLimiter({ windowMs: 60_000, limit: 100 }));
```

### Utilities

Hono's standalone helpers work anywhere:

```ts
import { HTTPException } from "hono/http-exception";

// Throw typed HTTP errors
throw new HTTPException(404, { message: "User not found" });
```

For the full list of built-in middleware, see the [Hono documentation](https://hono.dev/docs/middleware/builtin).
