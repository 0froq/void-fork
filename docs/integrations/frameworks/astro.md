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
  output: "server",
  adapter: cloudflare(),
  vite: { plugins: [voidPlugin()] },
});
```

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

All [Void platform features](../../app-types.md#void-apps) work with Astro. Use them in server endpoints and middleware:

### Database

```ts
// src/pages/api/users.ts
import type { APIRoute } from "astro";
import { db } from "void/db";

export const GET: APIRoute = async () => {
  const users = await db.list("users"); // fully typed from migrations
  return new Response(JSON.stringify(users));
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

```ts
import type { APIRoute } from "astro";
import { kv } from "void/kv";

export const GET: APIRoute = async () => {
  const settings = await kv.get("app:settings");
  return new Response(JSON.stringify(settings));
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
  return new Response(JSON.stringify(result));
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

You can also use Astro's `locals.runtime.env` in server endpoints and middleware:

```ts
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals }) => {
  const { DB } = locals.runtime.env;
  const { results } = await DB.prepare("SELECT * FROM users").all();
  return new Response(JSON.stringify(results));
};
```

Or the `cloudflare:workers` module:

```ts
import { env } from "cloudflare:workers";

const { results } = await env.DB.prepare("SELECT * FROM users").all();
```
