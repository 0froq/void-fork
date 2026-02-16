# Cloudflare

Vite Cloud runs on Cloudflare Workers. This page covers how bindings work, how the plugin merges your wrangler config, and how to deploy directly to your own Cloudflare account.

## Bindings

Vite Cloud automatically infers and provisions Cloudflare bindings (D1, KV, R2) by scanning your source files. There are two ways to access them at runtime depending on your setup.

### Via Hono context (`c.env`)

In Vite Cloud's default routing mode, route handlers and middleware receive a Hono `Context` object with bindings on `c.env`:

```ts
// routes/api/users.ts
import { defineHandler } from "vite-cloud";

export const GET = defineHandler(async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users").all();
  return c.json(results);
});
```

```ts
// routes/api/cache.ts
import { defineHandler } from "vite-cloud";

export const GET = defineHandler(async (c) => {
  const value = await c.env.KV.get("key");
  return c.json({ value });
});
```

`c.env` is fully typed via `CloudContext` -- no manual type declarations needed.

### Via `cloudflare:workers` import

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

### TypeScript setup

Add `"vite-cloud/env"` to your tsconfig `types` to get typed bindings on `env`:

```json
{
  "compilerOptions": {
    "types": ["vite-cloud/env"]
  }
}
```

This augments the `Cloudflare.Env` interface with `DB`, `KV`, and `STORAGE` and also pulls in `@cloudflare/workers-types`, so you don't need to add that separately.

### Available bindings

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

## Wrangler config merging

By default, Vite Cloud configures the Cloudflare plugin entirely programmatically -- you don't need a `wrangler.json`. Bindings are inferred from your source code and provisioned with local placeholder IDs for development.

If you add a `wrangler.json` (or `wrangler.toml`) to your project root, the Cloudflare Vite plugin reads it automatically. Vite Cloud merges its inferred bindings with your config:

- **Bindings you define** in `wrangler.json` (with real resource IDs) are preserved as-is.
- **Inferred bindings** that are missing from your config are added with local placeholder IDs.

For example, if your code uses `c.env.DB` and `c.env.KV`, and your `wrangler.json` only defines D1:

```json
{
  "name": "my-app",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ]
}
```

Vite Cloud sees that `DB` is already configured and leaves it alone, but adds a local placeholder for `KV` since it's missing. This means `pnpm dev` works out of the box (Miniflare creates local instances for all bindings), while `wrangler deploy` uses your real D1 database ID.

Settings like `main`, `triggers`, and `assets` are always set by Vite Cloud and don't need to be in your wrangler config.

## Deploy to your own Cloudflare account

Vite Cloud's default deployment path is `vcd deploy`, which uploads to the Vite Cloud platform. But the generated worker is a standard Cloudflare Worker -- you can deploy it directly to your own account with `wrangler deploy`.

### 1. Create your resources

Create whatever bindings your app uses:

```bash
# D1 database
wrangler d1 create my-app-db

# KV namespace
wrangler kv namespace create KV

# R2 bucket
wrangler r2 bucket create my-app-storage
```

### 2. Add a `wrangler.json`

Create `wrangler.json` in your project root with the resource IDs from step 1:

```json
{
  "name": "my-app",
  "compatibility_date": "2025-12-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app-db",
      "database_id": "<your-database-id>"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "<your-namespace-id>"
    }
  ],
  "r2_buckets": [
    {
      "binding": "STORAGE",
      "bucket_name": "my-app-storage"
    }
  ]
}
```

Only include the bindings your app actually uses. You don't need `main` or `assets` -- those are set by the plugin.

### 3. Run migrations

If your app uses D1, apply migrations before deploying:

```bash
wrangler d1 migrations apply DB --remote
```

This uses the same `migrations/` directory that Vite Cloud uses locally.

### 4. Build and deploy

```bash
vite build && wrangler deploy
```

That's it. The Cloudflare Vite plugin produces a complete build output with a generated `wrangler.json` in the dist directory, and `wrangler deploy` picks it up.

### Local development

`pnpm dev` continues to work as before -- Miniflare creates local instances of all bindings regardless of the IDs in your `wrangler.json`. Your real resource IDs are only used when you run `wrangler deploy`.
