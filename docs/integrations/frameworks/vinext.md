---
outline: deep
---

# Vinext

[Vinext](https://vinext.io/) is a Vite-based reimplementation of the Next.js API surface, built for Cloudflare Workers. `voidPlugin()` composes directly with the Vinext plugin in the Vite pipeline — no separate adapter needed.

Vinext supports both the **App Router** (React Server Components) and **Pages Router** (`getServerSideProps` / `getStaticProps`). Void auto-detects which router your project uses based on whether an `app/` or `pages/` directory exists.

## Setup

### 1. Create a new project

```bash
mkdir my-app && cd my-app
npm init -y
npm install vinext react react-dom
```

### 2. Install dependencies

```bash
npm install -D void
```

### 3. Configure `vite.config.ts`

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [
    voidPlugin(), // must come before the framework plugin
    vinext(),
  ],
});
```

### 4. Deploy

```bash
void auth login
void deploy
```

## Using Void Platform Features

All [Void platform features](../../app-types.md#void-apps) work with Vinext. Use them in server-side code — Server Components, Route Handlers, `getServerSideProps`, or API Routes depending on your router.

### Database

::: code-group

```tsx [App Router]
// app/users/page.tsx (Server Component)
import { db } from "void/db";

export default async function UsersPage() {
  const users = await db.list("users"); // fully typed from migrations
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
```

```tsx [Pages Router]
// pages/users.tsx
import { db } from "void/db";

export async function getServerSideProps() {
  const users = await db.list("users"); // fully typed from migrations
  return { props: { users } };
}
```

:::

### Auth

Use `getUser()` from `void/auth` to access the authenticated user:

::: code-group

```tsx [App Router]
// app/api/profile/route.ts
import { getUser } from "void/auth";

export async function GET() {
  const user = getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  return Response.json(user);
}
```

```tsx [Pages Router]
// pages/api/profile.ts
import { getUser } from "void/auth";

export default function handler(req, res) {
  const user = getUser();
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json(user);
}
```

:::

See [Authentication](../../auth.md) for setup, providers, and the full API.

### KV Storage

::: code-group

```tsx [App Router]
// app/settings/page.tsx
import { kv } from "void/kv";

export default async function SettingsPage() {
  const settings = await kv.get("app:settings");
  return <pre>{JSON.stringify(settings)}</pre>;
}
```

```tsx [Pages Router]
// pages/settings.tsx
import { kv } from "void/kv";

export async function getServerSideProps() {
  const settings = await kv.get("app:settings");
  return { props: { settings } };
}
```

:::

### Blob Storage

::: code-group

```tsx [App Router]
// app/api/avatar/route.ts
import { storage } from "void/storage";

export async function GET() {
  const avatar = await storage.get("avatars/user-1.png");
  return new Response(avatar.body, { headers: { "Content-Type": "image/png" } });
}
```

```tsx [Pages Router]
// pages/api/avatar.ts
import { storage } from "void/storage";

export default async function handler(req, res) {
  const avatar = await storage.get("avatars/user-1.png");
  res.setHeader("Content-Type", "image/png");
  res.send(avatar.body);
}
```

:::

### AI

::: code-group

```tsx [App Router]
// app/api/summarize/route.ts
import { ai } from "void/ai";

export async function POST(request: Request) {
  const { text } = await request.json();
  return Response.json(
    await ai.run("@cf/meta/llama-3.1-8b-instruct", { prompt: `Summarize: ${text}` }),
  );
}
```

```tsx [Pages Router]
// pages/api/summarize.ts
import { ai } from "void/ai";

export default async function handler(req, res) {
  const result = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: `Summarize: ${req.body.text}`,
  });
  res.json(result);
}
```

:::

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

You can also access Cloudflare bindings via the `cloudflare:workers` module:

```tsx
import { env } from "cloudflare:workers";

const { results } = await env.DB.prepare("SELECT * FROM users").all();
```
