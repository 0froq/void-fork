# Vite Cloud — Feature Roadmap

**Date:** February 2026
**Status:** Post-v1.0 planning
**Context:** Core platform (local dev, file-based routing, auto-provisioning, basic deployment) is implemented. This document captures additional features discussed during design, ordered by recommended implementation priority.

---

## Prioritization Framework

Features are scored on three axes (1–5 scale):

- **Implementation Complexity** — engineering effort and technical risk
- **Operational Cost** — ongoing infrastructure and support burden
- **Conversion Impact** — how strongly the feature drives free → paid upgrades, measured by how much pain it saves vs. building on raw Cloudflare

Composite score: `Conversion × (6 - Complexity) × (6 - OpCost)`. Higher = more attractive.

---

## Priority 1 — Quick Wins (High impact, low effort)

### 1.1 Zero-Downtime Database Migrations

**Scores:** Complexity 3 · OpCost 1 · Conversion 4 · Composite 60
**Phase:** Next release after v1.0

The deploy pipeline should guarantee that a failed migration never bricks a user's production database. The design uses a five-phase approach:

1. **Validate** — Parse migration SQL, reject destructive operations (`DROP COLUMN`, `DROP TABLE`, `ALTER TABLE ... RENAME`) unless the user adds a `-- vite-cloud:allow-destructive` pragma. Uses the principle that migrations should be additive-only by default (expand-and-contract pattern).
2. **Dry-run** — Apply pending migrations against a temporary shadow D1 database with the same schema. Catches syntax errors, constraint violations, and schema conflicts before touching production.
3. **Snapshot** — If destructive operations are present (with pragma), take a D1 snapshot via time-travel or export API before applying.
4. **Migrate** — Begin transaction on production D1, apply migration files in order, run schema validation, commit or rollback.
5. **Deploy** — Only after migration commits, deploy the new Worker to the dispatch namespace. Optionally run a user-defined health check (`GET /api/health`); roll back the Worker (not the data) if it fails.

Rollback story: code rollback is instant (re-deploy previous Worker version). Data rollback requires explicit `vite-cloud db restore --to <timestamp>` since auto-rolling back data risks data loss. This is by design — the default path is safe, the dangerous path requires opt-in.

Key invariant: the new Worker is never deployed unless the migration committed successfully. If the migration was additive and the Worker deploy fails, the old Worker keeps running against the new schema safely (it simply ignores the new columns/tables).

### 1.2 Cron & Background Jobs (File Convention)

**Scores:** Complexity 2 · OpCost 1 · Conversion 4 · Composite 60
**Phase:** Next release after v1.0

Map file conventions to Cloudflare Cron Triggers and Queues:

- `jobs/send-emails.ts` with an exported `cron` schedule string → creates a Cron Trigger, binds automatically
- `queues/` directory where each file is a queue consumer → provisions Queue, binds to worker

No wrangler config needed. The provisioning engine handles creation via CF API. Background processing is one of the first things users need after basic CRUD, and this is trivially easy to build since it's just codegen + provisioning — no new runtime primitives.

### 1.3 Per-Route Observability

**Scores:** Complexity 2 · OpCost 2 · Conversion 4 · Composite 48
**Phase:** Next release after v1.0

We already know the route structure at build time. Pipe Workers Logpush into an analytics D1 table and map each request to its source route file. Dashboard shows:

- Request volume, p50/p95 latency, error rates per route
- D1 query counts and timing per route
- Built-in error tracking linked to source route file

Replaces Sentry + Datadog for small-to-mid projects. Cloudflare only offers per-Worker analytics — we map to the developer's mental model. The dashboard is the main engineering work; the data pipeline is straightforward.

### 1.4 Core Web Vitals Monitoring

**Scores:** Complexity 1 · OpCost 1 · Conversion 3 · Composite 75
**Phase:** v1.1

The easiest frontend observability feature. The browser already does the measurement — we just collect and visualize.

Inject the `web-vitals` library (~1.5KB) into served HTML automatically. It measures LCP, INP, CLS, TTFB, and FCP, then beacons results to a built-in `/__vc/vitals` endpoint. The Worker writes to Cloudflare Analytics Engine (purpose-built for high-cardinality time-series, no storage limits, pennies per million data points).

Dashboard shows: p75 values per metric per page, trends over time, breakdown by device/connection type, pages failing Google's CWV thresholds. Directly actionable for SEO since Google uses CWV as a ranking signal.

Shares the same infrastructure pattern as per-route observability (1.3): injected client script → beacon to built-in endpoint → Analytics Engine → dashboard. After the first observability feature ships, each subsequent one is incremental.

### 1.5 Privacy-First SPA Analytics

**Scores:** Complexity 2 · OpCost 1 · Conversion 4 · Composite 60
**Phase:** v1.1

Replace Fathom ($15/mo) / Plausible ($9/mo) with built-in analytics.

Inject a tiny (~1KB) analytics script into served HTML. For full page loads, the Worker can count requests at the edge with zero client JS. For SPA navigation (no page reload), the script sends `navigator.sendBeacon('/__vc/analytics', { path, referrer })` on each client-side route change. Ingest endpoint writes to Analytics Engine.

Dashboard shows: page views, unique visitors (hashed IP + user agent — no cookies, no personal data), top pages, referrers, countries, devices. GDPR-compliant without consent banners by design — same privacy model as Fathom/Plausible.

Including this in the free tier is a strong conversion signal: one less service to pay for, one more reason to stay.

### 1.6 Error Tracking (Server + Client)

**Scores:** Complexity 2 · OpCost 1 · Conversion 4 · Composite 60
**Phase:** v1.1 (server-side), v1.2 (client-side)

**Server-side (v1.1):** Our Worker wraps every route handler in a try/catch. Unhandled exceptions are captured with full context: route file, request URL, params, headers, user session (if auth enabled). Written to Analytics Engine or D1. Dashboard shows errors grouped by route with occurrence counts, first/last seen, and stack traces.

**Client-side (v1.1 or v1.2):** Inject a small script hooking `window.onerror` and `window.onunhandledrejection`. Errors beacon to `/__vc/errors` with stack trace, URL, and browser info.

Source map resolution — typically the hard part of client-side error tracking — is uniquely tractable for us because we are the same team that built Rolldown (Vite 8's bundler). We write the code that produces the source maps. This means we can:

- Optimize the source map format for fast server-side resolution (compact index, pre-computed line mappings)
- Upload source maps to R2 during build as a first-class step in our pipeline
- Resolve stack frames on ingest in the Worker, so the dashboard always shows original file/line/function
- Potentially embed a lightweight resolution hint directly in the source map that skips the generic `source-map` library entirely

This advantage is structural — no other platform controls both the bundler output format and the error ingest pipeline. Sentry has to handle arbitrary source maps from any bundler. We only have to handle our own.

The positioning vs Sentry: we can't match Sentry's depth (replay, performance traces, release tracking, issue assignment). But "errors grouped by route with resolved stack traces" covers 80% of the need for most Vite Cloud users. And it's included, not $26/month.

### Frontend Observability — Combined Value Proposition

All three features (vitals, analytics, errors) share one infrastructure pattern:

```
tiny injected script (~1-1.5KB each)
  → beacon to built-in /__vc/* endpoint
    → Worker writes to Analytics Engine / D1
      → dashboard reads and visualizes
```

The injection mechanism, ingest pipeline, and dashboard framework are shared. Each feature after the first is incremental. The bundle replaces Fathom ($15/mo) + Sentry ($26/mo) + CWV tool ($10+/mo) = $50+/month of tooling. Including this in Pro at $20/month is a compelling value story.

User opt-in: all of this is enabled with a single config flag and can be toggled per feature:

```ts
export default defineConfig({
  plugins: [
    viteCloud({
      observability: true, // enables all three
      // or granularly:
      // observability: { analytics: true, vitals: true, errors: true }
    }),
  ],
});
```

---

## Priority 2 — Full-Stack Foundations

### 2.0 SSR Support (Minimal Entry Point Convention)

**Scores:** Complexity 2 · OpCost 1 · Conversion 3 · Composite 36
**Phase:** v1.1

We do not build our own SSR framework. Instead, we provide a thin convention: the user exports a `render` function from `src/main.ssr.ts`, and our Worker calls it for non-API, non-asset requests.

```ts
// src/main.ssr.ts
import { renderToReadableStream } from 'react-dom/server'
import App from './App'

export async function render(request: Request) {
  const stream = await renderToReadableStream(<App url={request.url} />)
  return new Response(stream, {
    headers: { 'content-type': 'text/html' }
  })
}
```

Worker request flow with SSR enabled:

1. Request for `/api/*` → file-based route handlers (existing behavior)
2. Request matches a static asset → serve from R2 (existing behavior)
3. Everything else → call the SSR entry's `render(request)` and stream back HTML

This works because `@cloudflare/vite-plugin` already handles SSR on Workers via the Vite Environment API (separate module graphs for client and server, server code runs in workerd). The build produces two outputs: client bundle (static assets → R2) and server bundle (Worker that renders pages + handles API routes). We get streaming SSR, proper hydration, and full Workers API access inside the render function — all for free from the underlying plugin.

This is deliberately minimal. No page routing, no data loading conventions, no server components. Those are the meta-framework's job (see 2.0a below). The SSR entry is for users who want basic SSR without adopting a full meta-framework.

### 2.0a Meta-Framework Compatibility (TanStack Start, SolidStart, SvelteKit, Analog)

**Scores:** Complexity 3 · OpCost 1 · Conversion 4 · Composite 48
**Phase:** v1.1 (adapters), ongoing (per-framework)

Vite Cloud should be a deployment target for meta-frameworks, not a competitor. The user's `vite.config.ts` composes both plugins:

```ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/start/vite";
import { viteCloud } from "vite-cloud";

export default defineConfig({
  plugins: [
    tanstackStart(), // routing, SSR, data loading
    viteCloud(), // deployment, bindings, provisioning
  ],
});
```

How they coexist: the meta-framework handles page routes, SSR, and data loading (server functions, `"use server"`, load functions). Our `routes/` directory handles standalone API endpoints not tied to pages (webhooks, cron handlers, external integrations). The Worker's fetch handler composes: meta-framework's handler gets first priority for page/asset requests, our file-based router handles `/api/*`.

The main integration work is binding access. Each meta-framework has its own way of exposing platform context to server code. We provide thin per-framework adapter packages:

- `vite-cloud/tanstack` — exposes `ctx.env` bindings inside `createServerFn`
- `vite-cloud/solidstart` — exposes bindings inside `"use server"` functions
- `vite-cloud/sveltekit` — exposes bindings in `+page.server.ts` load functions
- `vite-cloud/analog` — exposes bindings in Analog's server routes

These are small bridges (likely <100 lines each). The `@cloudflare/vite-plugin` already supports TanStack Start, SolidStart, and others on Workers — we layer on top and add auto-provisioning, managed auth, observability, and preview environments.

The positioning: "Use your favorite Vite-based framework. Deploy it on Vite Cloud. Get auto-provisioned databases, auth, observability, and preview environments for free." This is framework-agnostic NuxtHub — the exact gap in the market.

---

## Priority 3 — Moat Builders (High impact, medium effort)

### 3.1 Built-in Auth (Hono Middleware) + Plugin Tier

**Scores:** Complexity 2 · OpCost 2 · Conversion 5 · Composite 80
**Phase:** v1.0 (Tier 1), v1.1 (Tier 2)

**Do not build a custom auth library.** The built-in auth uses Hono's own middleware ecosystem (`@hono/oauth-providers`, `hono/jwt`). For advanced auth needs, a separate plugin (`@vite-cloud/plugin-better-auth`) provides smooth integration with better-auth.

#### Tier 1: Built-in Lightweight Auth

What `auth: true` or `auth: { providers: ['github', 'google'] }` does in `vite.config.ts`:

1. Auto-provisions D1 user table with schema: `{ id, provider, email, name, avatar_url, createdAt }`
2. Auto-provisions KV namespace for session storage
3. Generates OAuth login routes at `/auth/login/{provider}` and callback handler
4. Mounts auth middleware that reads session cookie, validates token in KV, populates `c.get("user")`
5. Generates `/auth/me` endpoint (returns current user or 401)
6. Exposes `c.get("user")` in every route handler (`{ id, provider, email, name, avatar_url }`)

**Zero additional dependencies** — uses only Hono's ecosystem: `@hono/oauth-providers`, `hono/jwt`, native Web Crypto.

End-user developer experience:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    viteCloud({
      auth: {
        providers: ["github", "google"],
      },
    }),
  ],
});
```

Environment variables: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Frontend login link:

```html
<a href="/auth/login/github">Sign in with GitHub</a>
```

Check auth status from the frontend:

```ts
const res = await fetch("/auth/me");
if (res.ok) {
  const user = await res.json(); // { id, provider, email, name, avatar_url }
}
```

Protect a route (inline check):

```ts
// routes/api/profile.get.ts
export default defineHandler((c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return { name: user.name, email: user.email };
});
```

Or use the convenience helper:

```ts
// routes/api/profile.get.ts
import { requireAuth } from "vite-cloud/auth";

export default defineHandler((c) => {
  const user = requireAuth(c); // throws 401 if not authenticated
  return { name: user.name, email: user.email };
});
```

Routes are mounted at `/auth/*` (not `/api/auth/*`): `/auth/login/{provider}`, `/auth/callback/{provider}`, `/auth/logout`, `/auth/me`.

#### Tier 2: `@vite-cloud/plugin-better-auth` (Separate Plugin)

A separate npm package for users who need email/password authentication, two-factor authentication, passkeys, organization management, multiple linked accounts, or additional OAuth providers beyond the built-in set.

When installed, it overrides the built-in auth entirely (mutually exclusive with Tier 1). It auto-provisions better-auth's tables (users, accounts, sessions, verifications), generates a typed client (`import { authClient } from "@vite-cloud/plugin-better-auth/client"`), and auto-generates migration files when the schema changes.

The key invariant: `c.get("user")` works in both tiers. Route handler code does not change when upgrading from Tier 1 to Tier 2.

#### Session Architecture: KV Opaque Tokens

Sessions use KV-backed opaque tokens, not signed JWT cookies, for three reasons:

1. **Revocation** — deleting a KV entry immediately invalidates a session. JWTs cannot be revoked before expiry without a deny-list.
2. **Server-side state** — KV sessions can store metadata (last active timestamp, IP, device info) without inflating the cookie.
3. **Size** — opaque session ID (~32 bytes) vs. JWT with claims (500+ bytes per request).

Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. KV key: `session:<random-uuid>`. KV value: `{ userId, createdAt, expiresAt }` with native `expirationTtl`.

#### Score Rationale

- **Complexity 2** (down from 4) — heavy lifting done by battle-tested Hono middleware. Our work is codegen: generate auth routes, add session middleware, write one D1 migration.
- **OpCost 2** — auto-provision KV and D1. KV sessions self-clean via TTL. User table grows linearly.
- **Conversion 5** — auth is the first problem every SaaS hits. "Add `auth: true`, get GitHub login with sessions" eliminates boilerplate.

Users can opt out entirely (just don't set `auth`), use the built-in tier, upgrade to the better-auth plugin, or use any external auth service (Clerk, Auth0, etc.). Not mutually exclusive.

### 3.2 Preview Environments with Database Forks

**Scores:** Complexity 3 · OpCost 3 · Conversion 5 · Composite 45
**Phase:** v1.1

When a PR-triggered preview deploy runs:

1. Clone the production D1 database via CF API (or export/import)
2. Deploy preview Worker at `{pr-num}--{project}.vitecloud.app`
3. Bind the cloned D1 to the preview Worker
4. Reviewers test against realistic data
5. Clean up cloned database when PR is closed/merged

Storage cost scales with number of active previews — manageable with TTLs and cleanup. This is a unique differentiator: no competitor offers automatic database forking per PR. Vercel previews are stateless, NuxtHub doesn't do this, raw Cloudflare requires manual work.

### 3.3 Integration Marketplace (Email, Payments, etc.)

**Scores:** Complexity 3 · OpCost 1 · Conversion 4 · Composite 48
**Phase:** v1.2

Typed binding adapters for common third-party services:

- "Add Resend" → provisions secret, adds typed `ctx.env.email` binding
- "Add Stripe" → webhook endpoint, `ctx.env.payments`
- Plugin architecture: `vite-cloud-plugin-stripe`

Start with 3–4 first-party plugins. Open the plugin spec for third-party contributions. Creates ecosystem moat and switching cost.

---

## Priority 4 — Power User Features

### 4.1 Escape Hatches for Raw Cloudflare Features

**Phase:** v1.2

A tiered model for progressive disclosure of Cloudflare complexity:

| Tier | Mechanism                                          | CF Account Needed | We Provision        | Examples                           |
| ---- | -------------------------------------------------- | ----------------- | ------------------- | ---------------------------------- |
| Auto | Inference from code                                | No                | Yes                 | D1, KV, R2                         |
| 1    | One-line config opt-in                             | No                | Yes                 | Workers AI, Vectorize, Hyperdrive  |
| 2    | Convention directory (`src/objects/`)              | No                | Yes                 | Durable Objects                    |
| 3    | Raw `wrangler.jsonc` passthrough                   | Yes (maybe)       | No                  | Queues config, mTLS, Email Workers |
| 4    | Full Worker takeover (`worker: './src/worker.ts'`) | No                | Yes (bindings only) | Custom fetch handler               |

**Tier 1** — Workers AI, Vectorize, Hyperdrive, Browser Rendering. One line in config: `ai: true` or `vectorize: 'my-index'`. We provision and bind, they show up as typed `ctx.env.ai`, etc. Requires explicit opt-in because of cost implications.

**Tier 2** — Durable Objects via `src/objects/` convention. Each file in that directory exports a DO class via `defineObject()`. Filename becomes the binding name. Build step registers DO classes and generates bindings automatically.

**Tier 3** — Raw `wrangler.jsonc` passthrough for anything we haven't abstracted. These bindings appear on `ctx.env` as raw CF types. The user manages the underlying resources themselves. This is an explicit "you're going beyond what Vite Cloud manages" boundary.

**Tier 4** — Full Worker takeover. Bypass file-based routing entirely, but keep auto-provisioning and managed deployment.

Key principle: for anything without a Vite Cloud abstraction, the user treats it as an external service they build on their own CF account and communicate with the main app over HTTP. This is the same model as Vercel + AWS — nobody expects Vercel to abstract every AWS service.

### 4.2 D1 Scaling Guidance & Hyperdrive Upgrade Path

**Phase:** v1.2

D1 has structural ceilings that users need to understand:

- **10 GB hard cap per database** — cannot be increased. CF's answer is horizontal sharding (up to 50K databases per account).
- **Single-writer, single-threaded** — ~1,000 queries/sec at 1ms/query. All writes go to one primary. Read replication (beta) helps distribute read load but writes remain serialized.
- **Single primary location** — without read replication, every query routes to database creation location. Global users see latency.
- **No Postgres features** — no stored procedures, LISTEN/NOTIFY, PostGIS, advanced JSON, materialized views.

D1 is the right default for most Vite Cloud users (early-stage SaaS, internal tools, content sites, personal projects). Users outgrow it when they need >10 GB single tables, write-heavy workloads, Postgres-specific features, or shared database access across multiple services.

The upgrade path is **Hyperdrive** (Tier 1 binding):

1. Spin up a Neon, Supabase, or PlanetScale database
2. Add config: `viteCloud({ hyperdrive: { connectionString: 'postgres://...' } })`
3. Switch from `ctx.env.db.prepare(...)` to `ctx.env.pg` (Postgres.js via Hyperdrive)
4. Export D1 data via `wrangler d1 export`, import into Postgres

Be transparent in docs: "D1 is included and auto-provisioned. It handles most apps effortlessly. When you need more, upgrade to an external Postgres database via Hyperdrive with one config change."

### 4.3 Edge WebSockets (defineWebSocket)

**Scores:** Complexity 4 · OpCost 3 · Conversion 3 · Composite 18
**Phase:** v1.2 (defer unless demand is clear)

Abstracts Durable Object complexity for real-time features:

- `routes/ws/chat/[room].ts` → real-time channel per room
- `defineWebSocket` handler abstracts DO creation, hibernation, room management

Genuinely hard to get right. DO pricing makes margins thin. Audience is narrower than other features. Build only when demand signals are strong.

---

## Priority 5 — Team & Enterprise

### 5.1 Environment Promotion (Staging → Production)

**Scores:** Complexity 2 · OpCost 2 · Conversion 4 · Composite 32
**Phase:** v2.0

Branch-based environments with isolated D1 per developer/environment. Promotion workflow validates migrations, runs health checks, then atomically swaps traffic. Key driver for Team plan ($50 base + $15/seat) upsell.

### 5.2 Team RBAC & Audit Logs

**Scores:** Complexity 3 · OpCost 1 · Conversion 3 · Composite 36
**Phase:** v2.0

Standard SaaS collaboration features: roles (admin, developer, viewer), permissions (who can deploy to production), audit trail (who deployed what and when). Expected by teams but not a unique differentiator. Build when Team plan launches.

### 5.3 Managed Auth SSO (SAML/OIDC)

**Scores:** Complexity 4 · OpCost 1 · Conversion 3 · Composite 18
**Phase:** v2.0

Enterprise table stakes. Complex to implement but low operational cost. Build only when pursuing enterprise contracts. Would extend `@vite-cloud/plugin-better-auth` with better-auth's enterprise SSO plugin.

---

## Priority 6 — Nice-to-Have & Polish

### 6.1 AI Code Generation

**Scores:** Complexity 2 · OpCost 1 · Conversion 3 · Composite 36
**Phase:** v1.1 or later

- `vite generate route users --crud` scaffolds CRUD handlers + D1 migrations + typed handlers
- AI assistant in dashboard analyzes D1 queries, Worker logs to answer "why is this endpoint slow?"

Thin wrapper over LLM API + our route conventions. Low cost (absorb small LLM costs or user pays). Adds polish but won't drive conversion alone.

### 6.2 AI Dashboard Assistant

**Phase:** v2.0+

"Why is this endpoint slow?" — analyzes actual D1 query patterns, Worker execution times, identifies missing indexes. Possible because we understand the app structure (routes, schemas, bindings) in a way Cloudflare cannot. Differentiated but not urgent.

---

## Implementation Timeline

```
v0.1  ✅ DONE
│  Core local dev, file-based routing, defineHandler,
│  auto-provisioning (D1/KV/R2), basic deployment,
│  *.vitecloud.app
|
v1.0 ← NEXT
│  ├── Zero-downtime migrations
│  ├── Cron & background jobs (file convention)
│  ├── SSR support (minimal entry point convention)
│  ├── Built-in Auth (Tier 1: Hono OAuth + sessions)
│  ├── GitHub integration (push to deploy)
│  └── Basic user dashboard
│
v1.1
│  ├── @vite-cloud/plugin-better-auth (Tier 2)
│  ├── Meta-framework adapters (TanStack Start, SolidStart, SvelteKit)
│  ├── Per-route observability
│  ├── Core Web Vitals monitoring
│  ├── Privacy-first SPA analytics
│  ├── Server-side error tracking
│  └── Client-side error tracking (with Rolldown source map advantage)
│
v1.2
│  ├── Preview environments with DB forks
│  ├── Integration marketplace (Resend, Stripe)
│  ├── Escape hatches (Tier 1: Workers AI, Vectorize, Hyperdrive)
│  ├── Escape hatches (Tier 2: Durable Objects convention)
│  ├── D1 → Hyperdrive upgrade path docs
│  ├── AI code generation (scaffolding)
│  └── Edge WebSockets (if demand signals)
│
v2.0
│  ├── Environment promotion (staging → prod)
│  ├── Team RBAC & audit logs
│  ├── Managed auth SSO (SAML/OIDC)
│  ├── AI dashboard assistant
│  └── Team plan launch ($50 + $15/seat)
```

---

## Key Design Decisions Captured

### On SSR

Do not build an SSR framework. Provide a minimal `src/main.ssr.ts` convention for users who want basic SSR without a meta-framework. For anything beyond that, be a deployment target for meta-frameworks (TanStack Start, SolidStart, SvelteKit, Analog). The meta-framework handles routing, SSR, data loading. We handle deployment, provisioning, and platform features.

### On Meta-Framework Compatibility

Vite Cloud should compose with meta-frameworks, not compete. Both plugins coexist in `vite.config.ts`. The meta-framework gets first priority for page/asset requests; our file-based router handles `/api/*`. Per-framework adapter packages (`vite-cloud/tanstack`, etc.) are thin bridges (<100 lines each) that expose `ctx.env` bindings inside each framework's server function convention. The positioning: "framework-agnostic NuxtHub."

### On Frontend Observability

We control both the deployment (Worker sits in front of every request) and the bundler output (Rolldown). This uniquely positions us to offer integrated analytics, error tracking, and CWV monitoring. All three share one infrastructure pattern (injected script → beacon → Analytics Engine → dashboard). The Rolldown advantage on source maps is structural: we can optimize the format for fast server-side resolution in ways no other platform can, because we produce the maps. The combined value ($50+/mo of tooling included in Pro at $20/mo) is a strong conversion driver.

### On Auth

Do not build a custom auth library. Tier 1 (built-in) uses Hono's own middleware ecosystem: `@hono/oauth-providers` for social login, `hono/jwt` for token operations. Vite Cloud's value-add is the wiring: auto-provisioning a user table (D1) and session store (KV), generating OAuth callback routes, and populating `c.get("user")` in every handler. Sessions are KV-backed opaque tokens, not signed JWTs, because revocation matters more than statelessness at this layer. Tier 2 (`@vite-cloud/plugin-better-auth`) is a separate plugin for users who need email/password, 2FA, passkeys, organizations, and other advanced auth features. The separation means the default path has zero additional dependencies, and users who outgrow Tier 1 adopt Tier 2 without changing their route handler code — both tiers populate `c.get("user")`. Users who already know better-auth bring their knowledge. Users who leave can take their code. Reduces lock-in perception, which helps adoption.

### On D1 Scaling

Be honest about D1's ceilings. It's the right default for most apps. When users outgrow it (>10 GB, write-heavy, need Postgres features), the upgrade path is Hyperdrive + external Postgres. Users who outgrow D1 are running serious production workloads and should be on Pro/Team plans. Good for business.

### On Escape Hatches

For any Cloudflare feature we don't abstract, the user treats it as an external service on their own CF account, communicating with the main app over HTTP. This keeps our operational surface small. The boundary is clear: Tiers Auto–2 are managed by us. Tier 3+ is "bring your own Cloudflare."

### On Migration Safety

Migrations are additive-only by default. Destructive operations require explicit pragma. Deploy pipeline: validate → dry-run (shadow DB) → snapshot (if destructive) → migrate (in transaction) → deploy worker → health check. New Worker never deploys unless migration commits. Data rollback is always explicit, never automatic.

---

## Competitive Positioning

**vs Vercel:** Not tied to Next.js, edge-first everywhere, auto-provisioned infra (not just hosting), database forking for previews.

**vs Cloudflare Pages/Workers:** No CF account needed, zero config, auto-provisioning, managed auth, per-route observability, migration safety.

**vs NuxtHub:** Framework-agnostic (works with any Vite app, not just Nuxt). Same auto-provisioning model proves the concept works.

**Theme:** Cloudflare gives primitives, we give product. Every feature is technically possible on raw CF but requires expertise and glue code. Our value: infrastructure → product features that work out of the box. The more we own (auth, data, observability, jobs), the more switching cost and the more we can charge.
