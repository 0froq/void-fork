# Implementation Progress

## Phase 1: Local Dev ✅

- [x] `void init` empty-directory scaffolding flow
- [x] Vite plugin wrapping `@cloudflare/vite-plugin`
- [x] `defineHandler` / `defineMiddleware` with type inference (Hono-based)
- [x] File-based routing from `routes/` (compiles to Hono app)
- [x] HTTP method routing via named exports (`export const GET/POST/...` per file)
- [x] Dynamic params, catch-all, and route groups
- [x] Middleware from `middleware/` directory with ordering
- [x] Binding inference via oxc `parseSync` (imported from `vite`) + estree-walker
- [x] Local runtime with D1/KV/R2 (via CF plugin's local bindings)
- [x] Hot reload for API handlers (via Environment API HMR)
- [x] Local migration runner

**Milestone:** ✅ A user can run `npm install -D void` + `npx void init` in an empty directory, add a route file using `defineHandler` that queries a database, and see it work locally with zero config.

## Phase 2: Platform & Deploy ✅

- [x] Control Plane API (projects, deploy endpoint) — `packages/api/`
- [x] Dispatch worker + `*.void.app` routing — `packages/dispatch/`
- [x] Static asset serving via R2 (SPA fallback, cache headers)
- [x] `void deploy` CLI command
- [x] D1 schema for users, projects, deployments, resources (Drizzle ORM)
- [x] Worker upload to CF dispatch namespace via API
- [x] KV-based routing table (`slug → { workerName, projectId }`)
- [x] Auth (GitHub OAuth → JWT, `void login` CLI command)
- [x] Provisioning engine (D1, KV, R2 creation via CF API)
- [x] Zero-downtime remote migration execution
- [x] Staging environment with auto-deploy on push to `main`

**Milestone:** ✅ Full deploy pipeline complete. Stateless deploy, provisioning, auth, and remote migrations all working.

## Phase 3: Developer-Facing Features (in progress)

### Completed

- [x] Secrets management (`void secrets`)
- [x] Cron jobs (`crons/` directory, `defineScheduled`)
- [x] Queues (`queues/` directory, `defineQueue`, typed producers/consumers)
- [x] SSR support (`defineRender` in `src/main.ssr.ts`)
- [x] Zero-config auth (email/password + OAuth, auto-detected from imports)
- [x] `defineHandler.withValidator()` — Standard Schema input validation (body/query/params)
- [x] Route type codegen (`.void/routes.d.ts` with `Serialize<T>` + `ExtractInput<V>`)
- [x] Typed `fetch` client (`void/client`) with path/method/input/output inference
- [x] Schema-derived DB types (SQL DDL parser → `.void/db.d.ts`)
- [x] Typed query helper (`void/db`) — `db.list/get/insert/update/delete/raw`
- [x] Seamless tsconfig (`.void/tsconfig.json` generated, user extends it)
- [x] Raw Cloudflare deployment (`vite build && wrangler deploy`)
- [x] Static deployment (`--dir`, `--spa`, VitePress/Vite auto-detection, SSG 404.html fallback)
- [x] Code generation (`void gen` — model, route, middleware, ssr, cron, queue)
- [x] `void db` commands (migrations, inspect)
- [x] `void init` — agent instructions, skills linking, prompt output
- [x] CLI skills for coding agents (Claude Code, Cursor, Codex, etc.)
- [x] MCP server shipped in-package (`void mcp`)
- [x] CLI lazy loading for startup performance
- [x] Pages mode — Inertia-inspired full-stack DX with Vue adapter (`@void-x/vue`)
- [x] Meta-framework adapters (TanStack Start — framework mode)

### Remaining

- [ ] Pages mode: React adapter
- [ ] Pages mode: update agent prompts for pages
- [ ] Pre-rendering (bring back with new architecture)
- [x] AI binding (`void/ai` with metered proxy)
- [x] Remote bindings (`remote: true` — D1/KV/R2 via proxy for local dev)
- [ ] Drizzle integration
- [ ] Better-auth integration
- [ ] More framework adapters (React Router, Astro, SvelteKit, Nuxt, SolidStart)
  - [ ] Make backend features (queues, crons, ISR) work alongside these

**Milestone:** Fully typed API routes end-to-end. Route handlers with validators produce typed `RouteMap` via codegen. Client `fetch()` infers path, method, input, and output types automatically.

## Phase 4: Production Readiness

### Completed

- [x] Custom domains (`void domains`)
- [x] Usage tiers, metering and limits enforcement
- [x] Admin dashboard (Hono JSX, merged into platform worker)
- [x] Staging environment with isolated CF resources
- [x] Staging sign-up allowlist (VoidZero Google accounts only)

### Remaining

- [x] Move platform DB to PlanetScale Postgres via Hyperdrive
- [ ] System monitoring / health pings
- [ ] User dashboard
- [ ] Improve sign-up page
- [ ] User token management (CF Secret Store?)
- [ ] Terms of Service
- [ ] Sign-up whitelist (public)
- [ ] Billing integration (Stripe)
- [ ] Email & webhook notifications (failed deploys, billing)

**Milestone:** Ready for public beta.

## Phase 5: GitHub + Build Containers

- [ ] GitHub App for webhook-based deploys
- [ ] Build infrastructure (CF containers)
- [ ] Preview deployments per PR (paid)

**Milestone:** Vercel / Netlify core DX parity.

## Phase 6: Growth (Post-Launch)

### Developer Tools

- [ ] `void devtools` — route visualization, local DB inspector, log tailing, remote project status
- [ ] Edge cache auto-warming after deploy
- [ ] Instant preview without deploying (CF tunnel)
- [ ] AI-powered codegen
- [ ] More MCP capabilities

### Observability

- [ ] Per-route observability (request volume, latency, error rates)
- [ ] Core Web Vitals monitoring (injected `web-vitals` → Analytics Engine)
- [ ] Privacy-first SPA analytics (no cookies, GDPR-compliant)
- [ ] Server-side error tracking (unhandled exceptions with route context)
- [ ] Client-side error tracking (with Rolldown source map advantage)

### Platform

- [ ] Email binding
- [ ] Durable Object session abstraction
- [ ] Preview environments with database forks (cloned D1 per PR)
- [ ] Integration marketplace (Resend, Stripe plugin architecture)
- [ ] Workers AI, Vectorize, Hyperdrive (one-line config)
- [ ] Durable Objects (`src/objects/` convention)
- [ ] D1 → Hyperdrive upgrade path
- [ ] Edge WebSockets via `defineWebSocket`

### Team & Enterprise

- [ ] Environment promotion (staging → production with migration validation)
- [ ] Team RBAC & audit logs
- [ ] Managed auth SSO (SAML/OIDC via better-auth enterprise plugin)
- [ ] AI dashboard assistant (query analysis, performance insights)
- [ ] Team plan launch

### Documentation

- [ ] Restructure docs (Nuxt-like)
- [ ] Testing guide
- [ ] Security guide
- [ ] Guide: Framework SSR examples / templates
- [ ] Guide: Building a blog
- [ ] Guide: Building an AI chat app
- [ ] Guide: Using Drizzle with D1
- [ ] Guide: External DB usage
- [ ] Guide: Using the Hono ecosystem
- [ ] Guide: Using raw CF bindings
- [ ] Guide: Migrating from raw CF to Void
- [ ] Guide: Deploying to raw CF
