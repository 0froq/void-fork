# SPA Playground

React SPA with API routes demonstrating routing, input validation, typed database queries, middleware, and cron jobs.

## Structure

```
src/
  App.tsx              # React UI with typed fetch client
  main.tsx             # React DOM entry point
routes/api/
  hello.ts             # GET — returns { message, timestamp }
  users/
    index.ts           # GET list + POST create (valibot validation)
    [id].ts            # GET single user by param
middleware/
  01.logger.ts         # Logs method + path for every request
migrations/
  001_create_users.sql # Creates users table (id, name, email, created_at)
  seed.sql             # Seeds sample data
crons/
  hourly-heartbeat.ts  # Writes last-heartbeat timestamp to KV every hour
```

## Features

- **Named method exports** — route files export `GET`, `POST`, etc. as separate handlers
- **Input validation** — `defineHandler.withValidator()` with valibot schemas for body and params
- **Typed fetch client** — `fetch` from `vite-cloud/client` with full type inference from route definitions
- **Typed DB queries** — `db.list()`, `db.get()`, `db.insert()` from `vite-cloud/db` with types auto-generated in `.vite-cloud/db.d.ts`
- **Middleware** — `defineMiddleware` for cross-cutting concerns (request logging)
- **Cron jobs** — `defineScheduled` with cron expression syntax (`"0 * * * *"`)
- **SQL migrations** — auto-applied on dev server start
- **Seamless tsconfig** — extends `.vite-cloud/tsconfig.json` for auto type discovery
