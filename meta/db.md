# Database DX — Ideas & Research

## Current State

Users interact with D1 via raw SQL on `c.env.DB`:

```ts
const result = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
  .bind(params.id)
  .first<User>();
```

The generic on `.first<T>()` is a trust-me cast — nothing validates that the SQL actually returns those columns. Users manually define types (`interface User { ... }`) and keep them in sync with migrations by hand.

The migration system (`migrations/*.sql`) already parses and validates SQL at build time: collecting files, detecting destructive ops, applying locally via `better-sqlite3`, and remotely via CF REST API.

## ORM Integration — Not Recommended as a Built-In

ORMs are opinion-heavy — picking one alienates users of another. Drizzle and Prisma have fundamentally different philosophies (code-first vs schema-first, thin vs thick). D1 support in ORMs is still maturing.

Nothing stops users from using an ORM today. `drizzle(c.env.DB)` works in a handler with zero framework support needed.

**Better play:** stay out of the way. Document how to bring your own ORM rather than coupling to one.

## Stack-Owned DX Opportunities

These are things only Vite Cloud can do because it owns migrations + codegen + dev server + deploy pipeline.

### 1. Schema-Derived Types from Migrations (High Value, Unique)

We already parse migration SQL. We can extract `CREATE TABLE` statements and generate TypeScript types:

```
migrations/001_create_users.sql  →  .vite-cloud/db-types.d.ts
```

**Input:**

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Output:**

```ts
// .vite-cloud/db-types.d.ts (auto-generated)
interface DbTables {
  users: {
    id: number;
    name: string;
    email: string;
    created_at: string | null;
  };
}
```

SQLite's type system is simple enough that this is tractable:

| SQLite Type     | TypeScript    | Notes       |
| --------------- | ------------- | ----------- |
| `INTEGER`       | `number`      |             |
| `TEXT`          | `string`      |             |
| `REAL`          | `number`      |             |
| `BLOB`          | `ArrayBuffer` |             |
| No type / `ANY` | `unknown`     | Strict mode |

Nullability: columns are nullable unless `NOT NULL` is present. `PRIMARY KEY` implies `NOT NULL`.

**Why this is the killer feature:** It's the thing ORMs do that people actually want — but done from raw SQL migrations without requiring an ORM. Users keep writing SQL, types stay in sync automatically. The generated types update on file save (same file-watching infra as `routes.d.ts`).

**Handling `ALTER TABLE`:** Migrations are applied in order. The codegen replays all `CREATE TABLE` and `ALTER TABLE` statements to build the final schema. `ADD COLUMN` adds a field, `DROP COLUMN` removes one, `RENAME COLUMN` renames.

**Open questions:**

- Should we also generate insert/select subtypes (e.g., `UsersInsert` omitting columns with defaults)?
- How to handle views? Probably skip for v1.

### 2. Type-Safe Query Helper (Follow-On to #1)

A thin wrapper over D1 that uses the generated table types:

```ts
import { db } from "vite-cloud/db";

// Fully typed — knows table shapes from migrations
const user = await db(c.env.DB).get("users", { where: { id: params.id } });
// → DbTables["users"] | null

const users = await db(c.env.DB).list("users", {
  where: { email: { like: "%@example.com" } },
  limit: 10,
});
// → DbTables["users"][]

await db(c.env.DB).insert("users", { name: "Bob", email: "bob@example.com" });
// Type error if unknown columns or wrong types
```

**This is NOT an ORM.** No relations, no connection management, no migration system (that's separate). It's a typed SQL generator that reads from the generated `DbTables` interface.

**Trade-offs:**

- Pro: eliminates raw SQL for CRUD, catches column typos at compile time
- Con: complex queries (joins, subqueries, aggregates) still need raw SQL
- Con: another API surface to maintain and document

**Recommendation:** ship schema-derived types first. See if the community wants a built-in helper vs. just using Drizzle with the generated types. The types alone are valuable even without a query helper.

### 3. Dev-Time Migration DX

Things the dev server can do because it owns the runtime:

**Auto-apply on save:** Watch `migrations/` and auto-apply new files during dev. We already have file-watching infra from the routing plugin. Currently migrations only run at dev startup.

**`vcd db reset`:** Drop and re-run all migrations locally. Implementation: delete the Miniflare SQLite file (we already know the exact path via `getMiniflareDatabasePath()`) and restart. Trivial.

**`vcd db status`:** Show which migrations are applied locally vs. remote. We have the local `_migrations` table and the platform API.

**Schema diff on deploy:** Before running migrations in production, show what will change. We already validate for destructive ops — extending to a full diff is a natural next step.

### 4. Dev Seed Files

A `seed.dev.sql` (or `seed/` directory) that only runs in dev mode. Avoids the pattern of putting `INSERT` statements in production migrations (which the playground currently does).

```
migrations/
  001_create_users.sql     ← runs in dev + prod
  002_add_posts.sql        ← runs in dev + prod
  seed.dev.sql             ← runs in dev only, after migrations
```

Easy to implement — the migration runner already distinguishes dev vs. prod.

## Priority Assessment

| Feature                              | Effort          | Value     | Unique to Vite Cloud? |
| ------------------------------------ | --------------- | --------- | --------------------- |
| Schema-derived types from migrations | Medium          | Very High | Yes                   |
| Dev seed files                       | Low             | Medium    | Somewhat              |
| Migration watch + auto-apply in dev  | Low             | Medium    | Somewhat              |
| `db reset` / `db status` CLI         | Low             | Medium    | No                    |
| Typed query helper                   | High            | High      | Yes (because of #1)   |
| ORM integration                      | Low (just docs) | Low       | No                    |

**Recommended order:** Schema-derived types → seed files → migration watch → CLI commands → (evaluate query helper based on community feedback)
