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

## Phase 2: Platform & Deploy ✅

- [x] Control Plane API (projects, deploy endpoint) — `packages/platform/`
- [x] Dispatch worker + `*.vitecloud.app` routing — `packages/dispatch/`
- [x] Static asset serving via R2 (SPA fallback, cache headers)
- [x] `vite-cloud deploy` CLI command — `packages/vite-cloud/src/deploy/`
- [x] D1 schema for users, projects, deployments, resources
- [x] Worker upload to CF dispatch namespace via API
- [x] KV-based routing table (`slug → { workerName, projectId }`)
- [x] Auth (GitHub OAuth → JWT, `vite-cloud login` CLI command)
- [x] Provisioning engine (D1, KV, R2 creation via CF API)
- [x] Zero-downtime remote migration execution

**Milestone:** ✅ Full deploy pipeline complete. Stateless deploy, provisioning, auth, and remote migrations all working. Migrations run before worker deploy (zero-downtime guarantee). Destructive-op detection with pragma override.

### Phase 3: Developer facing features (in progress)

- [x] Secrets management
- [x] Cron & background jobs (file convention)
- [x] SSR support (minimal `src/main.ssr.ts` convention)
- [x] Zero config auth (via `hono/basic-auth` and `@hono/oauth-providers`)

**Milestone:**

### Phase 4: GitHub & Production Readiness

- [ ] GitHub App for webhook-based deploys
- [ ] Build infrastructure (CF containers)
- [ ] Preview deployments per PR
- [ ] Custom domains
- [ ] Usage metering and limits enforcement
- [ ] Billing integration (Stripe)
- [ ] Dashboard (web UI for managing projects, viewing logs)
- [ ] Email notifications (e.g. for failed project builds or billing issues)
- [ ] Rate limiting and abuse protection on free tier

**Milestone:** Ready for public beta.

### Phase 5: Growth (Post-Launch)

#### v1.1 — Full-Stack & Observability

- [ ] Meta-framework adapters (TanStack Start, SolidStart, SvelteKit, Analog)
- [ ] better-auth plugin (`@vite-cloud/better-auth`)
- [ ] Per-route observability (request volume, latency, error rates per route)
- [ ] Core Web Vitals monitoring (injected `web-vitals` → Analytics Engine)
- [ ] Privacy-first SPA analytics (no cookies, GDPR-compliant)
- [ ] Server-side error tracking (unhandled exceptions with route context)
- [ ] Client-side error tracking (with Rolldown source map advantage)

#### v1.2 — Ecosystem & Power Users

- [ ] Preview environments with database forks (cloned D1 per PR)
- [ ] Integration marketplace (Resend, Stripe plugin architecture)
- [ ] Escape hatches — Tier 1: Workers AI, Vectorize, Hyperdrive (one-line config)
- [ ] Escape hatches — Tier 2: Durable Objects (`src/objects/` convention)
- [ ] D1 → Hyperdrive upgrade path
- [ ] AI code generation (`vite generate route` scaffolding)
- [ ] Edge WebSockets via `defineWebSocket` (if demand signals)

#### v2.0 — Team & Enterprise

- [ ] Environment promotion (staging → production with migration validation)
- [ ] Team RBAC & audit logs
- [ ] Managed auth SSO (SAML/OIDC via better-auth enterprise plugin)
- [ ] AI dashboard assistant (query analysis, performance insights)
- [ ] Team plan launch ($50 base + $15/seat)

See [Roadmap](./roadmap.md) for detailed feature specs and prioritization.
