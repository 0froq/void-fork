---
outline: deep
---

# Nuxt

[Nuxt](https://nuxt.com/) has its own CLI and build system based on Nitro. Add `voidPlugin()` to Nuxt's Vite config for binding inference, typed DB, and migrations during development.

## Setup

### 1. Install dependencies

```bash
npm install -D void
npx nuxi module add nitro-cloudflare-dev
```

The `nitro-cloudflare-dev` module enables `getPlatformProxy()` for local dev, giving you access to Cloudflare bindings during `nuxt dev`.

### 2. Configure `nuxt.config.ts`

```ts
import { voidPlugin } from "void";

export default defineNuxtConfig({
  nitro: {
    preset: "cloudflare-module",
  },
  modules: ["nitro-cloudflare-dev"],
  vite: { plugins: [voidPlugin()] },
});
```

By default, Nuxt Cloudflare dev runtime and `voidPlugin()` migrations share Wrangler's local state at `.wrangler/state/v3`, so no extra persistence configuration is required.

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

All [Void platform features](../../app-types.md#void-apps) work with Nuxt after deployment. During local development, Nuxt server routes must use `event.context.cloudflare.env` to access bindings because Nitro's server runtime doesn't go through Vite's plugin pipeline where the `cloudflare:workers` shim lives. See [Runtime Helpers in Dev Mode](./overview.md#runtime-helpers-in-dev-mode) for details.

### Database

During dev, use `event.context.cloudflare.env` directly:

```ts
// server/api/users.get.ts
export default defineEventHandler(async (event) => {
  const { DB } = event.context.cloudflare.env;
  const { results } = await DB.prepare("SELECT * FROM users").all();
  return results;
});
```

After deployment to workerd, `void/db` also works:

```ts
import { db } from "void/db";

export default defineEventHandler(async () => {
  return db.list("users"); // fully typed from migrations
});
```

### Auth

Use `getUser()` from `void/auth` to access the authenticated user in server routes and middleware:

```ts
// server/api/profile.get.ts
import { getUser } from "void/auth";

export default defineEventHandler(() => {
  const user = getUser();
  if (!user) throw createError({ statusCode: 401 });
  return user;
});
```

See [Authentication](../../auth.md) for setup, providers, and the full API.

### KV Storage

During dev, use the Nitro event context:

```ts
export default defineEventHandler(async (event) => {
  const { KV } = event.context.cloudflare.env;
  return KV.get("app:settings");
});
```

After deployment, `void/kv` also works:

```ts
import { kv } from "void/kv";

export default defineEventHandler(async () => {
  return kv.get("app:settings");
});
```

### Blob Storage

```ts
import { storage } from "void/storage";

export default defineEventHandler(async () => {
  return storage.get("avatars/user-1.png");
});
```

### AI

```ts
import { ai } from "void/ai";

export default defineEventHandler(async () => {
  return ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: "Summarize the latest news",
  });
});
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

Access bindings via the Nitro event context (works in both dev and production):

```ts
// server/api/users.get.ts
export default defineEventHandler(async (event) => {
  const { DB } = event.context.cloudflare.env;
  const { results } = await DB.prepare("SELECT * FROM users").all();
  return results;
});
```

::: tip Recommended for Dev
Using `event.context.cloudflare.env` is the recommended approach for Nuxt server routes during local development. It works because `nitro-cloudflare-dev` provides Cloudflare bindings through Nitro's event context.
:::
