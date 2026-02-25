---
outline: deep
---

# Astro

[Astro](https://astro.build/) has its own CLI and Cloudflare adapter (`@astrojs/cloudflare`). Add `voidPlugin()` to Astro's Vite config for binding inference, typed DB, and migrations during development.

## Setup

### 1. Install dependencies

```bash
npm install -D @astrojs/cloudflare void
```

### 2. Configure `astro.config.mjs`

```js
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { voidPlugin } from "void";

export default defineConfig({
  adapter: cloudflare({
    platformProxy: {
      persist: { path: ".void/v3" }, // share D1 data with migration plugin
    },
  }),
  vite: { plugins: [voidPlugin()] },
});
```

The `persist.path` must be `.void/v3` so that `@astrojs/cloudflare` reads from the same D1 database that the migration plugin writes to.

### 3. Create `wrangler.jsonc`

`voidPlugin()` auto-syncs inferred bindings into this file on dev startup:

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat"],
}
```

### 4. Deploy

```bash
void login
void deploy
```

## Using Void Platform Features

All [Void platform features](../../app-types.md#void-apps) work with Astro after deployment. During local development, Astro SSR pages must use `Astro.locals.runtime.env` to access bindings because Astro's SSR module resolution doesn't go through Vite's plugin pipeline where the `cloudflare:workers` shim lives. See [Runtime Helpers in Dev Mode](./overview.md#runtime-helpers-in-dev-mode) for details.

Pages that access runtime bindings must opt out of prerendering:

```astro
---
export const prerender = false;
// now Astro.locals.runtime is available
---
```

### Database

During dev, use `Astro.locals.runtime.env` directly:

```astro
---
export const prerender = false;
const { DB } = Astro.locals.runtime.env;
const { results } = await DB.prepare("SELECT * FROM users").all();
---
<ul>
  {results.map(user => <li>{user.name}</li>)}
</ul>
```

In API routes:

```ts
// src/pages/api/users.ts
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals }) => {
  const { DB } = locals.runtime.env;
  const { results } = await DB.prepare("SELECT * FROM users").all();
  return Response.json(results);
};
```

After deployment to workerd, `void/db` also works:

```ts
import type { APIRoute } from "astro";
import { db } from "void/db";

export const GET: APIRoute = async () => {
  const users = await db.list("users"); // fully typed from migrations
  return Response.json(users);
};
```

### Auth

Use `getUser()` from `void/auth` to access the authenticated user in API routes and middleware:

```ts
import type { APIRoute } from "astro";
import { getUser } from "void/auth";

export const GET: APIRoute = async () => {
  const user = getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  return Response.json(user);
};
```

See [Authentication](../../auth.md) for setup, providers, and the full API.

### KV Storage

During dev, use the runtime directly:

```ts
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals }) => {
  const { KV } = locals.runtime.env;
  const settings = await KV.get("app:settings");
  return Response.json(settings);
};
```

After deployment, `void/kv` also works:

```ts
import type { APIRoute } from "astro";
import { kv } from "void/kv";

export const GET: APIRoute = async () => {
  const settings = await kv.get("app:settings");
  return Response.json(settings);
};
```

### Blob Storage

```ts
import type { APIRoute } from "astro";
import { storage } from "void/storage";

export const GET: APIRoute = async () => {
  const avatar = await storage.get("avatars/user-1.png");
  return new Response(avatar);
};
```

### AI

```ts
import type { APIRoute } from "astro";
import { ai } from "void/ai";

export const POST: APIRoute = async () => {
  const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: "Summarize the latest news",
  });
  return Response.json(result);
};
```

### Cron Jobs

```ts
// crons/daily-cleanup.ts
import { defineScheduled } from "void";

export const cron = "0 0 * * *";

export default defineScheduled(async () => {
  // runs daily at midnight
});
```

### Queue Consumers

```ts
// queues/emails.ts
import { defineQueue } from "void";

export default defineQueue<{ to: string; subject: string }>(async (batch) => {
  for (const msg of batch.messages) {
    // process each message
    msg.ack();
  }
});
```

## Accessing Bindings Directly

Access bindings via `Astro.locals.runtime.env` (works in both dev and production):

```ts
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals }) => {
  const { DB } = locals.runtime.env;
  const { results } = await DB.prepare("SELECT * FROM users").all();
  return Response.json(results);
};
```

In `.astro` pages (remember to set `prerender = false`):

```astro
---
export const prerender = false;
const { DB } = Astro.locals.runtime.env;
const { results } = await DB.prepare("SELECT * FROM users").all();
---
```

::: tip Recommended for Dev
Using `Astro.locals.runtime.env` is the recommended approach for Astro pages during local development. It works because `@astrojs/cloudflare` provides Cloudflare bindings through the Astro runtime context.
:::
