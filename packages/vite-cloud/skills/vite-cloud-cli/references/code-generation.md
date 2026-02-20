# Code Generation

All `vcc gen` commands create new files. **Existing files are never overwritten.**

## Model

```sh
npx vcc gen model <name> [columns...]
```

Scaffolds a complete model: migration + CRUD API routes + regenerated `db.d.ts`.

```sh
npx vcc gen model posts title:string body:text published:boolean
```

Creates:

- `migrations/NNN_create_posts.sql` — CREATE TABLE with `id`, your columns, and `created_at`
- `routes/api/posts/index.ts` — GET (list) + POST (insert with validation)
- `routes/api/posts/[id].ts` — GET by id with 404 handling
- Regenerated `.vite-cloud/db.d.ts`

**Column format:** `name:type` or `name:type?` (nullable)

**Types:** `string`, `text`, `datetime` → TEXT; `integer`, `boolean` → INTEGER; `real` → REAL; `blob` → BLOB

**Validation:** auto-detects valibot, zod, or arktype from `package.json`. If none found, prompts to choose or skip.

**Names:** must be lowercase alphanumeric with underscores (e.g. `posts`, `user_roles`).

## Migration

```sh
npx vcc gen migration <name>
```

Empty SQL file with auto-numbered prefix: `migrations/NNN_<name>.sql`.

## Route

```sh
npx vcc gen route <path> [--methods get,post,...]
```

Creates `routes/<path>.ts` with `defineHandler` exports. Defaults to GET.

```sh
npx vcc gen route api/health
npx vcc gen route api/users --methods get,post,delete
```

## Middleware

```sh
npx vcc gen middleware <name>
```

Creates `middleware/NN.<name>.ts` with `defineMiddleware` export. Prefix auto-detected from existing files.

## SSR

```sh
npx vcc gen ssr [--react | --vue | --svelte | --solid]
```

Scaffolds SSR entry points: `src/main.ssr.{tsx,ts}`, `src/main.client.{tsx,ts}`, and `src/App.{tsx,vue,svelte}`. Auto-detects framework from `package.json` if no flag given.

## Cron

```sh
npx vcc gen cron <name>
```

Creates `crons/<name>.ts` with `defineScheduled` and a placeholder cron expression.

## Queue

```sh
npx vcc gen queue <name>
```

Creates `queues/<name>.ts` with `defineQueue`, a `Message` interface, and commented-out batch options.
