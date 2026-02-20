# Typed Fetch

Vite Cloud ships a typed `fetch` client that knows every route in your app. Import it from `vite-cloud/client` and get autocomplete for paths, type-checked request bodies, and fully inferred response types.

## Basic Usage

```ts
import { fetch } from "vite-cloud/client";

// GET — return type inferred from your handler
const users = await fetch("/api/users");

// POST — body type-checked against your handler's validator
await fetch("/api/users", {
  method: "POST",
  body: { name: "Alice", email: "alice@example.com" },
});

// Dynamic params interpolated from the route pattern
const user = await fetch("/api/users/:id", {
  params: { id: "42" },
});
```

No type annotations needed — everything is inferred from your route handlers.

## What Gets Type-Checked

The client constrains every part of the request:

- **Paths** — only routes defined in `routes/` are accepted. Typos are compile-time errors.
- **Methods** — only methods exported from the route file are allowed. If a file only exports `GET`, passing `method: "POST"` is an error.
- **Body, query, params** — when your handler uses [`defineHandler.withValidator()`](./server-routing.md#validation), the validator schemas become the input types. The client enforces them at the call site.
- **Response type** — the return type matches what your handler returns, after [JSON serialization](./type-safety.md#serialization).

## Query Parameters

Pass `query` for GET requests with search parameters:

```ts
// routes/api/search.ts
export const GET = defineHandler.withValidator({
  query: z.object({ q: z.string(), page: z.string().optional() }),
})((c, { query }) => {
  return { results: [], term: query.q };
});

// Client — query is type-checked
const data = await fetch("/api/search", {
  query: { q: "hello" },
});
// data: { results: never[]; term: string }
```

## Error Handling

Non-2xx responses throw a `FetchError`:

```ts
import { fetch, FetchError } from "vite-cloud/client";

try {
  await fetch("/api/users/:id", { params: { id: "999" } });
} catch (e) {
  if (e instanceof FetchError) {
    console.log(e.status); // 404
    console.log(e.data); // parsed response body
    console.log(e.response); // raw Response
  }
}
```

## Options

| Option    | Type                     | Description                                                |
| --------- | ------------------------ | ---------------------------------------------------------- |
| `method`  | `string`                 | HTTP method. Defaults to `"GET"`.                          |
| `body`    | `object`                 | Request body (auto-serialized as JSON).                    |
| `query`   | `Record<string, string>` | Query string parameters.                                   |
| `params`  | `Record<string, string>` | URL path parameters (`:id` segments).                      |
| `headers` | `HeadersInit`            | Additional request headers.                                |
| `signal`  | `AbortSignal`            | Abort signal.                                              |
| `baseURL` | `string`                 | Base URL prepended to the path. Useful for external calls. |
| `retry`   | `number`                 | Number of retry attempts (default: 1 for GET).             |
| `timeout` | `number`                 | Request timeout in milliseconds.                           |

## Isomorphic Fetch During SSR

`fetch()` from `vite-cloud/client` works seamlessly during server-side rendering and inside route handlers — no HTTP round-trip is needed. In the worker environment, `fetch()` calls your Hono app directly via `app.fetch()`, skipping the network entirely.

```ts
// src/main.ssr.tsx
import { fetch } from "vite-cloud/client";
import { defineRender } from "vite-cloud";

export default defineRender(async (c, assetTags) => {
  // This calls your API route directly — no HTTP request
  const data = await fetch("/api/users");

  const html = renderToString(<App users={data} />);
  return new Response(html, {
    headers: { "content-type": "text/html" },
  });
});
```

**Automatic header forwarding**: `cookie` and `authorization` headers from the incoming request are automatically forwarded to subrequests, so authentication context is preserved. If you pass these headers explicitly, your values take precedence.

**How it works**: In the browser, `fetch()` uses the normal HTTP client. In the worker, Vite Cloud redirects the import to a virtual module that calls `app.fetch()` directly using the Hono app instance. AsyncLocalStorage threads the outer request context so headers and `waitUntil()` work correctly.

## Using Your Own ORM

The built-in [database helper](./db.md) covers simple CRUD, but you're not locked into it. Any ORM or query builder that works with D1 works with Vite Cloud — just pass the D1 binding.

For example, with [Drizzle](https://orm.drizzle.team/docs/get-started/d1-new):

```ts
// db/drizzle.ts
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";

export const db = drizzle(env.DB);
```

```ts
// routes/api/users.ts
import { defineHandler } from "vite-cloud";
import { db } from "../../db/drizzle";
import { users } from "../../db/schema";

export const GET = defineHandler(async (c) => {
  return await db.select().from(users);
});
```

The typed fetch client works regardless of how your handler queries the database — it infers the response type from whatever the handler returns. This means Drizzle, Kysely, raw D1 queries, or any other approach all get the same end-to-end type safety on the client side.

Vite Cloud still handles binding inference (it detects `env.DB` usage and provisions D1 automatically), migrations, and deployment. The query layer is the only part you're swapping out.
