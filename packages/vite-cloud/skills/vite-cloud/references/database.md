# Database

All `vite-cloud db` commands operate on the **local** D1 database (Miniflare). Remote databases are managed automatically during deploy (pending migrations are applied).

## Commands

### Status

```sh
npx vite-cloud db status
```

Shows which migrations are applied or pending locally. When logged in and linked, also shows remote status.

**Run this first** before any other db operation to understand current state.

### Migrate

```sh
npx vite-cloud db migrate
```

Apply pending migrations only. **Preserves existing data.** Use this for incremental updates.

### Reset

```sh
npx vite-cloud db reset
```

**Destructive.** Drops the local database entirely and re-applies all migrations from scratch. Use when you need a clean slate.

### Seed

```sh
npx vite-cloud db seed [--file <path>]
```

Reset + migrate + execute a seed file. Defaults to `migrations/seed.sql`. The seed file is excluded from migration collection — it is never deployed or applied remotely.

### Execute

```sh
npx vite-cloud db execute "<sql>"
npx vite-cloud db execute --file <path>
```

Run ad-hoc SQL against the local database. SELECT queries display results as a formatted table.

### Export

```sh
npx vite-cloud db export [--output <path>] [--no-data] [--no-schema] [--table <name>]
```

Dump local database as SQL. Outputs to stdout by default.

| Flag              | Purpose                            |
| ----------------- | ---------------------------------- |
| `--output <path>` | Write to file instead of stdout    |
| `--no-data`       | Schema only (no INSERT statements) |
| `--no-schema`     | Data only (no CREATE TABLE)        |
| `--table <name>`  | Export a single table              |

## Gotchas

- `db reset` vs `db migrate`: reset is destructive, migrate preserves data. When in doubt, use `migrate`.
- Seed files live in `migrations/` but are excluded from the migration collection.
- Migration files must be numbered sequentially (e.g. `001_create_users.sql`, `002_add_posts.sql`). Use `npx vite-cloud gen migration <name>` to auto-number.
