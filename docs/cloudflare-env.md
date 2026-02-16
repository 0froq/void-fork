# Cloudflare Env

Vite Cloud automatically infers and provisions Cloudflare bindings (D1, KV, R2) by scanning your source files. There are two ways to access them at runtime depending on your setup.

## Via Hono context (`c.env`)

In Vite Cloud's default routing mode, route handlers and middleware receive a Hono `Context` object with bindings on `c.env`:

```ts
// routes/api/users.get.ts
import { defineHandler } from "vite-cloud";

export default defineHandler(async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users").all();
  return c.json(results);
});
```

```ts
// routes/api/cache.get.ts
import { defineHandler } from "vite-cloud";

export default defineHandler(async (c) => {
  const value = await c.env.KV.get("key");
  return c.json({ value });
});
```

`c.env` is fully typed via `CloudContext` -- no manual type declarations needed.

## Via `cloudflare:workers` import

When using framework mode (TanStack Start, React Router, SolidStart), the framework owns routing and you access bindings through the `cloudflare:workers` module instead:

```ts
import { env } from "cloudflare:workers";

const result = await env.DB.prepare("SELECT * FROM users").all();
```

This also works in server functions:

```tsx
// src/routes/users.tsx (TanStack Start)
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const getUsers = createServerFn().handler(async () => {
  const { results } = await env.DB.prepare("SELECT * FROM users").all();
  return results;
});

export const Route = createFileRoute("/users")({
  loader: () => getUsers(),
  component: UsersPage,
});
```

## TypeScript setup

Add `"vite-cloud/env"` to your tsconfig `types` to get typed bindings on `env`:

```json
{
  "compilerOptions": {
    "types": ["vite-cloud/env"]
  }
}
```

This augments the `Cloudflare.Env` interface with `DB`, `KV`, and `STORAGE` and also pulls in `@cloudflare/workers-types`, so you don't need to add that separately.

## Available bindings

| Binding   | Type          | Trigger                                         |
| --------- | ------------- | ----------------------------------------------- |
| `DB`      | `D1Database`  | `env.DB` or `c.env.DB` usage detected           |
| `KV`      | `KVNamespace` | `env.KV` or `c.env.KV` usage detected           |
| `STORAGE` | `R2Bucket`    | `env.STORAGE` or `c.env.STORAGE` usage detected |

Bindings are inferred automatically by scanning your source files for these access patterns. You can also set them explicitly in `vite.config.ts`:

```ts
viteCloud({
  bindings: { db: true, kv: true, storage: false },
});
```

See [Configuration](./config.md) for details.
