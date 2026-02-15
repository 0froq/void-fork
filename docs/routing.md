# Routing

Vite Cloud routing runs on a generated Hono app.

It uses a file-system router from `routes/` plus optional global middleware from `middleware/`.

If `src/main.ssr.ts` exists, route handlers still run first and SSR is used as a fallback for unmatched non-API requests.

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
