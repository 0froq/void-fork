---
outline: deep
---

# ORMs and External Databases

Void's built-in [database helper](../database.md) covers common CRUD without writing SQL, but you're not locked into it. Any ORM or query builder that works with D1 works with Void — just pass the D1 binding. Void still handles binding inference, migrations, and deployment regardless of which query layer you use.

You're also free to skip D1 entirely and connect to an external database like PostgreSQL or MySQL — see [External Databases](#external-databases) below.

## Drizzle ORM

[Drizzle](https://orm.drizzle.team) is a TypeScript ORM with a SQL-like query builder that maps well to D1. Use it when you need joins, aggregations, batch operations, or more control than the built-in helper provides.

### Setup

Install `drizzle-orm` and `drizzle-kit`:

```bash
npm install drizzle-orm
npm install -D drizzle-kit
```

### Define Your Schema

Create a schema file that describes your tables using Drizzle's SQLite helpers:

```ts
// db/schema.ts
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("user").$type<"user" | "admin">(),
  created_at: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [index("idx_posts_user_id").on(t.user_id)],
);
```

Use `.$type<T>()` on text columns to narrow TypeScript types to specific unions.

### Create the Client

```ts
// db/drizzle.ts
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import * as schema from "./schema";

export const db = drizzle(env.DB, { schema });
```

Passing `schema` enables Drizzle's relational query API. The `env.DB` import triggers Void's binding inference — D1 is provisioned automatically.

### Queries

Use `db` directly in your route handlers:

```ts
// routes/api/users.ts
import { defineHandler } from "void";
import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { users } from "../../db/schema";

// List all users
export const GET = defineHandler(async () => {
  return await db.select().from(users).all();
});

// Create a user
export const POST = defineHandler(async (c) => {
  const body = await c.req.json<{ name: string; email: string }>();
  const [user] = await db.insert(users).values(body).returning();
  return c.json(user, 201);
});
```

```ts
// routes/api/users/[id].ts
import { defineHandler } from "void";
import { eq } from "drizzle-orm";
import { db } from "../../../db/drizzle";
import { users } from "../../../db/schema";

// Get a user by ID
export const GET = defineHandler(async (c) => {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, Number(c.req.param("id"))))
    .get();

  if (!user) return c.json({ error: "not found" }, 404);
  return user;
});

// Update a user
export const PUT = defineHandler(async (c) => {
  const body = await c.req.json<{ name?: string; email?: string }>();
  const [updated] = await db
    .update(users)
    .set(body)
    .where(eq(users.id, Number(c.req.param("id"))))
    .returning();

  if (!updated) return c.json({ error: "not found" }, 404);
  return updated;
});

// Delete a user
export const DELETE = defineHandler(async (c) => {
  await db.delete(users).where(eq(users.id, Number(c.req.param("id"))));
  return c.body(null, 204);
});
```

### Joins

```ts
import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { users, posts } from "../../db/schema";

// Posts with author name
const results = await db
  .select({
    id: posts.id,
    title: posts.title,
    author: users.name,
  })
  .from(posts)
  .innerJoin(users, eq(posts.user_id, users.id))
  .all();
```

### Batch Operations

D1 supports batching multiple statements into a single round-trip:

```ts
import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { users, posts } from "../../db/schema";

// Delete a user and all their posts in one batch
await db.batch([
  db.delete(posts).where(eq(posts.user_id, userId)),
  db.delete(users).where(eq(users.id, userId)),
]);
```

### Migrations

You have two options for managing migrations with Drizzle:

**Option A: Use Void's migration system (recommended).** Write SQL files in `migrations/` as usual. Void applies them automatically on dev startup and deploy. Your Drizzle schema is just a TypeScript representation of your tables — it doesn't generate or run migrations.

**Option B: Use Drizzle Kit to generate migrations.** Add a `drizzle.config.ts` and point the output to `migrations/`:

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
```

Then generate migrations from schema changes:

```bash
npx drizzle-kit generate
```

This creates SQL files in `migrations/` which Void picks up and applies like any other migration. The schema file becomes the source of truth — you modify the schema, run generate, and Drizzle diffs it into a SQL migration for you.

::: tip
Whichever option you choose, Void handles applying migrations. You don't need Drizzle Kit's `push` or `migrate` commands — Void runs pending SQL files on dev startup and during deploy.
:::

## Other ORMs

Any ORM or query builder that accepts a D1 binding works the same way — import `env.DB` from `cloudflare:workers` and pass it to your library's initialization function.

### Kysely

```ts
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { env } from "cloudflare:workers";

const db = new Kysely<Database>({ dialect: new D1Dialect({ database: env.DB }) });
```

### Raw D1

```ts
import { env } from "cloudflare:workers";

const { results } = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).all();
```

## External Databases

D1 isn't your only option. You can connect to external databases using [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) (connection pooling for PostgreSQL/MySQL) or direct TCP via any database driver that supports `connect()`.

Void's binding inference detects Hyperdrive usage from `env.HYPERDRIVE` and provisions the binding automatically. Add your connection string as a secret:

```bash
void secrets set HYPERDRIVE_CONNECTION_STRING "postgres://user:pass@host:5432/db"
```

```ts
// routes/api/data.ts
import { defineHandler } from "void";
import { env } from "cloudflare:workers";
import postgres from "postgres";

export const GET = defineHandler(async () => {
  const sql = postgres(env.HYPERDRIVE.connectionString);
  const rows = await sql`SELECT * FROM analytics LIMIT 100`;
  return rows;
});
```
