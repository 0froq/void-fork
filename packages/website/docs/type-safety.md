# Type Safety

Vite Cloud provides end-to-end type safety across your entire stack — from database queries, through route handlers, to frontend fetch calls. Types are derived from your source code and SQL migrations. Nothing is manually written or duplicated.

## The Type Pipeline

```
SQL migrations → DB types → Route handlers → Route types → Typed fetch client
```

Each layer feeds into the next:

1. **Database types** are generated from your `migrations/*.sql` files. The plugin replays DDL statements to build a schema, then generates TypeScript interfaces for every table.
2. **Route handler types** are extracted from your `routes/` files using `typeof import(...)`. Return types, validator schemas, and parameter patterns all become part of the generated `RouteMap`.
3. **The fetch client** consumes the `RouteMap` to type-check paths, methods, request bodies, and response types at the call site.

All generated types live in `.vite-cloud/` and update automatically when you change source files or migrations.

## Database → Handler

Types from `vite-cloud/db` are inferred from your migration SQL. When a handler queries the database, the return type flows through naturally:

```ts
// migrations/001_create_users.sql
// CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)

// routes/api/users.ts
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

export const GET = defineHandler(async (c) => {
  const users = await db.list("users", { select: ["name", "email"] });
  return users;
  // Return type: { name: string; email: string }[]
});
```

TypeScript knows the shape of `users` because it was derived from the migration. The handler's return type is then captured by the route type generator.

## Handler → Client

The typed fetch client infers its types from your handler's return type and validator schemas:

```ts
// src/App.tsx
import { fetch } from "vite-cloud/client";

const users = await fetch("/api/users");
// users: { name: string; email: string }[]

users[0].name; // ✓ string
users[0].missing; // ✗ TypeScript error
```

No type annotation on `users` — it's inferred from the GET handler's return type, after JSON serialization.

## Validators Close the Loop

When you add input validation with `defineHandler.withValidator()`, the schemas become part of the route's type. The fetch client enforces them at the call site:

```ts
// routes/api/users.ts
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";
import * as v from "valibot";

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})(async (c, { body }) => {
  await db.insert("users", body);
  return { created: true };
});
```

```ts
// src/App.tsx
import { fetch } from "vite-cloud/client";

// ✓ body shape matches the validator schema
await fetch("/api/users", {
  method: "POST",
  body: { name: "Alice", email: "alice@example.com" },
});

// ✗ TypeScript error — missing 'email'
await fetch("/api/users", {
  method: "POST",
  body: { name: "Alice" },
});
```

The validator schema is the single source of truth — it defines runtime validation, handler input types, and client-side type checking all at once.

## What Gets Checked

| Layer        | What's type-checked                                                    |
| ------------ | ---------------------------------------------------------------------- |
| Database     | Table names, column names, value types, required vs optional on insert |
| Handlers     | `c.env` bindings, validator input, return type                         |
| Fetch client | Route paths, HTTP methods, `body`/`query`/`params`, response type      |

## Serialization

The type system models JSON serialization. A `Serialize<T>` transform is applied to handler return types so the client sees what actually arrives over the wire:

| Source type                       | Serialized type                                           |
| --------------------------------- | --------------------------------------------------------- |
| `string`, `number`, `boolean`     | unchanged                                                 |
| `Date`                            | `string`                                                  |
| `Response`                        | excluded (passed through at runtime, not in typed output) |
| `bigint`, `Function`, `undefined` | excluded                                                  |
| `Array<T>`                        | `Array<Serialize<T>>`                                     |
| `{ key: T }`                      | `{ key: Serialize<T> }` (function-valued keys stripped)   |

## Context Variables

Route handlers and middleware share data through Hono's context variables (`c.set()` / `c.get()`). Vite Cloud's `CloudContextVariables` interface defines the variable types, and you can augment it to add your own:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from "vite-cloud";

declare module "vite-cloud" {
  interface CloudContextVariables {
    requestId: string;
  }
}

export default defineMiddleware(async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
});
```

Now `c.get("requestId")` returns `string` in every handler and middleware — no type assertions needed.

This is standard TypeScript [declaration merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html). Multiple augmentations across different files are merged together, so each middleware can declare what it provides.

## Setup

Extend the generated tsconfig in your project's `tsconfig.json`:

```json
{
  "extends": "./.vite-cloud/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "types": ["vite-cloud/env"]
  },
  "include": ["src", "routes", "middleware", "crons", "queues"]
}
```

The `"extends"` line is the key part. The generated `.vite-cloud/tsconfig.json` uses `"files"` to include both `routes.d.ts` and `db.d.ts`, which TypeScript inherits automatically. You do not need to add `.vite-cloud` to your `include` array.

> The `.vite-cloud/` files are generated when the dev server starts or when you build. Run `vite dev` or `vite build` at least once to generate them.
