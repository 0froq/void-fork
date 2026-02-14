Implementation Progress

## Phase 1: Local Dev ✅

- [x] `create-vite-cloud` scaffolding CLI
- [x] Vite plugin wrapping `@cloudflare/vite-plugin`
- [x] `defineHandler` / `defineMiddleware` with type inference (Hono-based)
- [x] File-based routing from `routes/` (compiles to Hono app)
- [x] HTTP method routing via filename suffix (`.get.ts`, `.post.ts`)
- [x] Dynamic params, catch-all, and route groups
- [x] Middleware from `middleware/` directory with ordering
- [x] Binding inference via oxc `parseSync` (imported from `vite`) + estree-walker
- [x] Local runtime with D1/KV/R2 (via CF plugin's local bindings)
- [x] Hot reload for API handlers (via Environment API HMR)
- [x] Local migration runner



**Milestone:** ✅ A user can run `npm create vite-cloud`, add a route file using `defineHandler` that queries a database, and see it work locally with zero config.

## Phase 2: Platform & Deploy (in progress)

- [x] Control Plane API (projects, deploy endpoint) — `packages/platform/`
- [x] Dispatch worker + `*.vitecloud.app` routing — `packages/dispatch/`
- [x] Static asset serving via R2 (SPA fallback, cache headers)
- [x] `vite-cloud deploy` CLI command — `packages/vite-cloud/src/deploy/`
- [x] D1 schema for users, projects, deployments, resources
- [x] Worker upload to CF dispatch namespace via API
- [x] KV-based routing table (`slug → { workerName, projectId }`)
- [x] Auth (GitHub OAuth → JWT, `vite-cloud login` CLI command)
- [x] Provisioning engine (D1, KV, R2 creation via CF API)
- [ ] Zero-downtime remote migration execution

**Milestone:** Stateless deploy works (Steps 1–5 complete). Provisioning engine done (Step 7). Auth done (Step 8). Remote migrations remain.

### Phase 3: GitHub & Production Readiness (Weeks 11–16)

- [ ] GitHub App for webhook-based deploys
- [ ] Build infrastructure (CF containers)
- [ ] Preview deployments per PR
- [ ] Custom domains
- [ ] Secrets management
- [ ] Usage metering and limits enforcement
- [ ] Billing integration (Stripe)
- [ ] Dashboard (web UI for managing projects, viewing logs)
- [ ] Rate limiting and abuse protection on free tier

**Milestone:** Ready for public beta.

### Phase 4: Growth (Post-Launch)

See [Roadmap](./roadmap/md).
