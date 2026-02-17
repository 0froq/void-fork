Possible enhancements to the current query builder API:

## 1. Column selection

Easiest win. Add a `select` option that narrows the return type:

```ts
list<T extends TableName, K extends keyof Row<T>>(table: T, options?: {
  select?: K[];
  where?: WhereClause<T>;
  // ...
}): Promise<Pick<Row<T>, K>[]>;
```

This is pure type-level work — the runtime implementation just changes `SELECT *` to `SELECT col1, col2`. Zero API complexity added.

## 2. `IN` operator in where clauses

Allow arrays in `WhereClause` to mean `IN`:

```ts
type WhereClause<T extends TableName> = {
  [K in keyof Row<T>]?: Row<T>[K] | Row<T>[K][];
};
```

Now `{ status: ["active", "pending"] }` becomes `WHERE status IN ('active', 'pending')`. Users already intuit this — it's how MongoDB, Prisma, and Supabase all work. No new syntax to learn.

## 3. `orderBy` as array for multi-column sorting

```ts
orderBy?: OrderExpr<T> | OrderExpr<T>[];
```

Trivial change, and people hit this quickly (e.g., "sort by status, then by created_at desc").

## 4. `count` method

```ts
count<T extends TableName>(table: T, options?: {
  where?: WhereClause<T>;
}): Promise<number>;
```

Same shape as `get`, but returns a number. You need this constantly for pagination and it's awkward to do via `raw()`.

---

## What I'd resist adding

- **Comparison operators** (`gt`, `lt`, `like`, `between`) — this is where APIs start bloating. You'd need either Drizzle-style operator functions or a nested object syntax like `{ age: { $gt: 18 } }`. Either one significantly complicates `WhereClause` and starts you down the path of reinventing a query builder. The `raw()` escape hatch is the right answer here.
- **Joins** — same story. Adding joins means adding column disambiguation, return type merging, and join conditions. That's half of Kysely's codebase.
- **Aggregations / GROUP BY** — these fundamentally change the return type and need a different API shape entirely.

The four additions above keep the API in the "zero learning curve CRUD helper" category while covering noticeably more real-world usage. Everything else pushes you toward building Kysely.
