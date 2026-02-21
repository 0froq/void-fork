# TanStack Start Playground

Demonstrates Vite Cloud integration with the TanStack Start meta-framework — TanStack handles routing and SSR, Vite Cloud provides Cloudflare bindings, migrations, and deployment.

## Structure

```
src/
  router.tsx              # Router configuration
  routeTree.gen.ts        # Auto-generated route tree
  routes/
    __root.tsx            # Root layout with nav
    index.tsx             # Home page with server function
    users.tsx             # Users page — D1 query via server function
  types/
    bindings.d.ts         # Worker bindings type
migrations/
  001_create_users.sql    # Users table with sample data
```

## Features

- **File-based routing** — TanStack's file-based routing from `src/routes/`
- **Server functions** — `createServerFn().handler()` for type-safe server-side operations
- **Data loaders** — `loader()` on routes pre-fetches data before component render
- **D1 integration** — server function accesses `env.DB` from `cloudflare:workers` directly
- **SSR** — TanStack Start handles SSR + client hydration automatically
- **Plugin ordering** — `viteCloud()` must come **before** `tanstackStart()` in the Vite plugins array
