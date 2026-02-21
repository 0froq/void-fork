## Vite Cloud

This project uses [Vite Cloud](https://vite.cloud) — a fullstack Vite plugin + deployment platform for Cloudflare. `viteCloud()` in `vite.config.ts` gives you file-based API routing on Hono (`routes/`), Inertia-inspired server-rendered pages with co-located loaders/actions (`pages/` + `@vite-cloud/vue` or `@vite-cloud/react`), auto-provisioned D1/KV/R2 bindings, end-to-end type safety (SQL migrations -> typed DB -> typed routes -> typed fetch client), built-in auth, queues, cron jobs, edge caching (ISR), and one-command deploys via `npx vcc deploy`.

Full docs are in `node_modules/vite-cloud/docs/`. If you have the `vite-cloud` skill available, use it for a complete API reference covering project structure, routing, pages mode, database, auth, typed fetch, KV, storage, queues, cron jobs, CLI, configuration, and deployment.
