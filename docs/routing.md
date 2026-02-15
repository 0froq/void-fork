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

`defineHandler(fn)` is a typed identity helper for route handlers.

Handler signature (Hono context):

```ts
(c: CloudContext) => unknown | Promise<unknown>;
```

`CloudContext` is a Hono `Context` with typed Cloudflare bindings on `c.env`.

Return values:

- `Response`: returned as-is
- `null`/`undefined`: `204 No Content`
- `string`: `text/html; charset=utf-8`
- object/array/number/boolean: JSON response

You can also call Hono response helpers directly (`c.json()`, `c.text()`, etc.).

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

Apply Hono middleware to individual routes by composing inside the handler:

```ts
// routes/api/webhooks/stripe.post.ts
import { defineHandler } from "vite-cloud";
import { bearerAuth } from "hono/bearer-auth";

const auth = bearerAuth({ token: "webhook-secret" });

export default defineHandler(async (c) => {
  // Run middleware manually for this route only
  const result = await auth(c, async () => {});
  if (result) return result;

  const body = await c.req.json();
  return { received: true };
});
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
