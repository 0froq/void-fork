# Database

Vite Cloud provides automated migration application and a typed query helper for [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) that covers common CRUD operations without writing SQL. Import `db` from `vite-cloud/db` and start querying.

## Migrations

Define your schema with SQL migration files in the `migrations/` directory:

```sql
-- migrations/001_create_users.sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);
```

Migrations run automatically when the dev server starts. On deploy, they run against the remote D1 database before the new worker goes live.

> **Naming:** Files are sorted by filename, so prefix with numbers (`001_`, `002_`, etc.) to control execution order.

## Querying

The `db` object provides typed methods for common operations. Types are derived from your migration files — no manual type definitions needed.

### List rows

```ts
import { db } from "vite-cloud/db";

const users = await db.list("users");
// users: { id: number; name: string; email: string; role: string; created_at: string | null }[]
```

Filter, sort, and paginate:

```ts
const admins = await db.list("users", {
  where: { role: "admin" },
  orderBy: "name ASC",
  limit: 10,
  offset: 20,
});
```

### Get a single row

```ts
const user = await db.get("users", { where: { id: 1 } });
// user: { id: number; name: string; ... } | null
```

### Insert

```ts
await db.insert("users", {
  name: "Alice",
  email: "alice@example.com",
});
```

Required and optional fields are enforced at the type level. Columns with `DEFAULT` values or `PRIMARY KEY AUTOINCREMENT` are optional in the insert type.

### Update

```ts
await db.update("users", {
  set: { role: "admin" },
  where: { id: 1 },
});
```

### Delete

```ts
await db.delete("users", { where: { id: 1 } });
```

### Count

```ts
const total = await db.count("users");
const adminCount = await db.count("users", { where: { role: "admin" } });
```

### Raw SQL

For queries that don't fit the helper methods, use `db.raw()`:

```ts
const results = await db.raw<{ name: string; total: number }>(
  "SELECT name, COUNT(*) as total FROM users GROUP BY name",
);
```

## Column Selection

Pass `select` to retrieve only the columns you need:

```ts
const names = await db.list("users", {
  select: ["name", "email"],
});
// names: { name: string; email: string }[]
// ✗ names[0].id — TypeScript error, not selected
```

Works with `get` too:

```ts
const user = await db.get("users", {
  select: ["name"],
  where: { id: 1 },
});
// user: { name: string } | null
```

The return type is automatically narrowed to only the selected columns.

## Filtering with `IN`

Where clause values can be arrays, which produce `IN (...)` queries:

```ts
const specific = await db.list("users", {
  where: { id: [1, 2, 3] },
});
// SQL: SELECT * FROM users WHERE id IN (?, ?, ?)
```

Mix scalar and array values freely:

```ts
const filtered = await db.list("users", {
  where: { role: "admin", id: [1, 2, 3] },
});
// SQL: SELECT * FROM users WHERE role = ? AND id IN (?, ?, ?)
```

## Multi-column Ordering

Pass an array to `orderBy` to sort by multiple columns:

```ts
const sorted = await db.list("users", {
  orderBy: ["role ASC", "name ASC"],
});
```

Single-column ordering still works as a plain string:

```ts
const sorted = await db.list("users", { orderBy: "name DESC" });
```

## How It Works

The query helper is powered by three pieces working together:

1. **Migration parsing** — At dev server start and build time, the plugin reads your `migrations/*.sql` files and replays the DDL statements (CREATE TABLE, ALTER TABLE, DROP TABLE) through a schema parser to build a complete picture of your database schema.

2. **Type generation** — The schema is used to generate `.vite-cloud/db.d.ts`, which augments the `DbTables` and `DbInsertTables` interfaces from `vite-cloud/db`. This gives every table and column a TypeScript type derived from the SQL column types (`INTEGER` → `number`, `TEXT` → `string`, `REAL` → `number`, `BLOB` → `ArrayBuffer`). Nullable columns get `| null`. Columns with defaults or autoincrement primary keys become optional in the insert type.

3. **Runtime client** — The `db` object builds parameterized SQL from the method calls, validates all identifiers to prevent injection, and executes queries against the D1 binding. All values are passed as bound parameters — never interpolated into SQL strings.

The generated types update automatically when you add or modify migration files. The dev server watches the `migrations/` directory and regenerates types on changes.

> **Escape hatch:** The query helper is intentionally limited to simple CRUD. For joins, subqueries, aggregations, or anything complex, use `db.raw()` with a manual type parameter. The helper and raw SQL work against the same D1 database.
