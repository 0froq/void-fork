# Vite Cloud — Coding Agent Reference

Vite Cloud is a zero-config Cloudflare deployment platform and Vite plugin. Add `viteCloud()` to your Vite config and get file-based API routing (Hono), auto-provisioned D1/KV/R2 bindings, end-to-end type safety from SQL to fetch client, and one-command deploys to `<slug>.vitecloud.app`.

> Full docs: `node_modules/vite-cloud/docs/` — each section below links to the relevant file.

## Project Structure

```
├── routes/              # File-based API routes (→ URL paths)
│   └── api/
│       └── hello.get.ts
├── middleware/           # Global middleware (numbered: 01.logger.ts)
├── migrations/          # SQL migrations (001_create_users.sql)
├── crons/               # Cron jobs (defineScheduled)
├── queues/              # Queue consumers (defineQueue)
├── src/                 # Frontend / app code
├── vite.config.ts       # Vite config with viteCloud()
├── vite-cloud.json      # Optional config (auth, bindings, headers, mode)
├── .vite-cloud/         # Generated types (routes.d.ts, db.d.ts, tsconfig.json)
└── .env / .env.local    # Environment variables
```

## Setup

**`vite.config.ts`:**

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

**`tsconfig.json`:**

```json
{
  "extends": "./.vite-cloud/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["vite-cloud/env"]
  },
  "include": ["src", "routes", "middleware", "crons", "queues"]
}
```

The `extends` line pulls in generated `routes.d.ts` and `db.d.ts` automatically. Run `vite dev` once to generate `.vite-cloud/`.

> Docs: `docs/type-safety.md`

## Routing

> Docs: `docs/routing.md`

Files in `routes/` map to URL paths:

| File                       | URL              |
| -------------------------- | ---------------- |
| `routes/index.ts`          | `/`              |
| `routes/api/users.ts`      | `/api/users`     |
| `routes/api/users/[id].ts` | `/api/users/:id` |
| `routes/docs/[...slug].ts` | `/docs/*`        |

- `_`-prefixed files/dirs are ignored
- `(group)` directories are route groups (no URL effect)
- `.dev.ts` / `.prod.ts` suffix restricts to that environment

### Handlers

Use named exports for HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Or use `export default` for a single-method route (method from filename suffix like `hello.get.ts`).

```ts
import { defineHandler } from "vite-cloud";

export const GET = defineHandler((c) => {
  return { users: [] }; // object → JSON response
});

export const POST = defineHandler((c) => {
  return { created: true };
});
```

**Return value rules:**

- Object/array → JSON (`application/json`)
- String → HTML (`text/html`)
- `null` → 204 No Content
- `Response` → pass-through

### Validation

```ts
import { defineHandler } from "vite-cloud";
import * as v from "valibot"; // or zod, arktype

export const POST = defineHandler.withValidator({
  body: v.object({ title: v.string(), body: v.string() }),
})(async (c) => {
  const { title, body } = c.req.valid("json");
  // title and body are typed strings
});
```

Supports any Standard Schema library (Zod, Valibot, ArkType). Validation errors return `400` with `{ error, issues }`.

> Docs: `docs/routing.md`, `docs/hono.md`

## Middleware

> Docs: `docs/routing.md`

**Global middleware** — files in `middleware/` with numeric prefixes:

```ts
// middleware/01.logger.ts
import { defineMiddleware } from "vite-cloud";

export default defineMiddleware(async (c, next) => {
  console.log(`${c.req.method} ${c.req.url}`);
  await next();
});
```

**Per-route middleware** — pass middleware before the handler:

```ts
export const GET = defineHandler(myMiddleware, (c) => {
  return { ok: true };
});
```

## Database

> Docs: `docs/db.md`

Built on Cloudflare D1 (SQLite). Auto-provisioned — just create migrations and import `db`.

**Migrations** in `migrations/` with numbered prefixes:

```sql
-- migrations/001_create_users.sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Migrations run automatically on `vite dev` and `vcc deploy`.

**Query API:**

```ts
import { db } from "vite-cloud/db";

db.list("users"); // all rows
db.list("users", { where: { active: 1 }, orderBy: "name", limit: 10 });
db.get("users", { where: { id: 1 } }); // single row or null
db.insert("users", { name: "Alice", email: "alice@example.com" });
db.update("users", { set: { name: "Bob" }, where: { id: 1 } });
db.delete("users", { where: { id: 1 } });
db.count("users", { where: { active: 1 } });
db.raw<T>("SELECT * FROM users WHERE id = ?", [1]);
```

Types are auto-generated from migration DDL into `.vite-cloud/db.d.ts`. No manual type definitions needed.

**Scaffolding:** `npx vcc gen model users name:string email:string bio:text?` creates migration + CRUD routes + regenerated types.

## Auth

> Docs: `docs/auth.md`

Auto-detected from imports or env vars. No config required.

**Server-side:**

```ts
import { requireAuth } from "vite-cloud/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c); // throws 401 if unauthenticated
  return { user };
});
```

**Client-side:**

```ts
import { auth } from "vite-cloud/client";

await auth.register({ email, password, name });
await auth.login({ email, password });
const user = await auth.me(); // AuthUser | null
await auth.logout();
```

For OAuth: set `GITHUB_OAUTH_ID`, `GITHUB_OAUTH_SECRET` (and/or Google equivalents) as env vars. Routes like `GET /auth/login/github` are generated automatically.

Explicit config in `vite-cloud.json`: `{ "auth": ["github", "google", "email"] }`.

## Typed Fetch Client

> Docs: `docs/type-safety.md`, `docs/typed-fetch.md`

```ts
import { fetch } from "vite-cloud/client";

const users = await fetch("/api/users");
// ✅ Path, method, body, and response types all inferred from route handlers
```

The type pipeline: SQL migrations → DB types → route handler return types → `RouteMap` → typed fetch. Types update automatically when you change routes or migrations.

## KV (Key-Value)

> Docs: `docs/kv.md`

```ts
import { kv } from "vite-cloud/kv";

await kv.set("key", { data: true }, { ttl: 3600 });
const value = await kv.get<MyType>("key");
await kv.delete("key");
await kv.list({ prefix: "user:" });

// Typed maps with auto-prefixing
const sessions = kv.map<Session>("sessions");
await sessions.set("abc", data); // key: "sessions:abc"
await sessions.get("abc"); // Session | null
```

## Object Storage

> Docs: `docs/storage.md`

Direct R2 binding — no abstraction layer.

```ts
import { storage } from "vite-cloud/storage";

await storage.put("avatar.png", file);
const obj = await storage.get("avatar.png");
await storage.delete("avatar.png");
await storage.list({ prefix: "uploads/" });
```

## Queues

> Docs: `docs/queues.md`

**Consumer** — files in `queues/`, filename becomes queue name:

```ts
// queues/emails.ts
import { defineQueue } from "vite-cloud";

export default defineQueue<{ to: string; subject: string }>(async (batch) => {
  for (const msg of batch.messages) {
    console.log(msg.body.to, msg.body.subject);
    msg.ack();
  }
});
```

**Producer:**

```ts
import { queues } from "vite-cloud/queues";

await queues.emails.send({ to: "user@example.com", subject: "Hello" });
// Type-safe: message shape inferred from consumer's generic parameter
```

## Cron Jobs

> Docs: `docs/jobs.md`

Files in `crons/`, must export `cron` schedule and `defineScheduled` handler:

```ts
// crons/cleanup.ts
import { defineScheduled } from "vite-cloud";

export const cron = "0 * * * *"; // every hour
// or: export const cron = ["0 * * * *", "30 * * * *"];

export default defineScheduled(async (controller, env, ctx) => {
  // cleanup logic
});
```

`_`-prefixed files are ignored. Schedules are auto-configured on deploy.

## CLI Quick Reference

| Command                             | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `vcc init`                          | Set up vite-cloud in an existing project            |
| `vcc init --agent`                  | Add coding agent instructions (CLAUDE.md/AGENTS.md) |
| `vcc deploy`                        | Build and deploy to Vite Cloud                      |
| `vcc login` / `logout` / `whoami`   | Authentication                                      |
| `vcc secret put <name[=value]>`     | Set a project secret                                |
| `vcc secret sync <file>`            | Sync secrets from .env file                         |
| `vcc db status`                     | Show migration status                               |
| `vcc db reset`                      | Reset local DB and re-run migrations                |
| `vcc db seed`                       | Reset, migrate, and run seed.sql                    |
| `vcc gen model <name> [cols...]`    | Generate migration + CRUD routes + types            |
| `vcc gen migration <name>`          | Generate empty migration                            |
| `vcc gen route <path>`              | Generate route file                                 |
| `vcc gen middleware <name>`         | Generate middleware file                            |
| `vcc gen cron <name>`               | Generate cron job file                              |
| `vcc gen queue <name>`              | Generate queue consumer                             |
| `vcc gen ssr [--react\|--vue\|...]` | Generate SSR entry files                            |
| `vcc domain add <hostname>`         | Add custom domain                                   |
| `vcc link [name]`                   | Link to an existing project                         |

> Docs: `docs/cli.md`

## Configuration

> Docs: `docs/config.md`

Optional `vite-cloud.json` at project root:

```json
{
  "auth": ["github", "google", "email"],
  "bindings": { "db": true, "kv": true, "storage": false },
  "headers": { "/assets/*": ["Cache-Control: public, max-age=31536000"] },
  "mode": "spa"
}
```

All fields optional. Bindings are auto-inferred from source imports if not specified. Mode is auto-detected.

## Environment Variables

> Docs: `docs/env-vars.md`

- **`.env`** — committed, non-secret defaults. All vars available in worker via `c.env`. `VITE_`-prefixed vars also available on `import.meta.env` client-side.
- **`.env.local`** — gitignored secrets for local dev. Not deployed.
- **`vcc secret put`** — production secrets. Use `vcc secret sync .env.local` to sync.

## Cloudflare Bindings

DB, KV, and Storage bindings are auto-inferred from imports (`vite-cloud/db`, `vite-cloud/kv`, `vite-cloud/storage`). Queue bindings are inferred from `queues/` directory. No manual Cloudflare dashboard configuration needed.

Access raw bindings via `c.env.DB`, `c.env.KV`, `c.env.STORAGE`, `c.env.QUEUE_*`.

> Docs: `docs/cloudflare.md`

## Deployment

> Docs: `docs/deployment.md`

```bash
npx vcc deploy
# or with explicit project:
npx vcc deploy --project my-app
```

On first deploy, Vite Cloud auto-provisions all required resources (D1, KV, R2, queues). Migrations run before the worker is deployed — if migrations fail, the deploy is aborted.

**GitHub Actions:**

```yaml
- run: npx vcc deploy
  env:
    VITE_CLOUD_TOKEN: ${{ secrets.VITE_CLOUD_TOKEN }}
```

Generate the workflow with `vcc init --github`. Get a token with `vcc token`.

## Hono

The runtime is built on [Hono](https://hono.dev). All `hono/*` subpaths work. Use Hono middleware, response helpers (`c.json()`, `c.text()`, `c.header()`), streaming (`hono/streaming`), and `HTTPException` for typed errors.

> Docs: `docs/hono.md`
