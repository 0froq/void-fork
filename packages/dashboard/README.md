# @voidcloud/dashboard

User-facing dashboard for Void. Built as a Vue Pages mode app, dogfooding the platform.

## Architecture

- **Vue Pages mode** — `voidPlugin()` + `voidVue()`, SSR with client hydration
- **Direct Postgres reads via Hyperdrive** — middleware initializes a Drizzle DB client from `env.HYPERDRIVE.connectionString`, and loaders query the platform database directly for read-heavy views.
- **API for mutations** — all write operations (add/remove domain, set/remove secret) go through the platform API.
- **API for non-DB reads** — usage metrics and secret operations still go through the platform API.
- **Auth** — OAuth (GitHub/Google) via the platform's `/auth/login` flow. JWT stored in an httpOnly cookie (`void_token`). Middleware validates the token and initializes the shared loader state.
- **Styling** — Tailwind CSS v4 with shared CSS tokens from `@voidcloud/ui`.

## Pages

| Route           | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `/login`        | OAuth buttons (GitHub, Google)                  |
| `/`             | Project list + aggregate usage summary          |
| `/projects/:id` | Deployments, usage, domains, secrets, resources |
| `/settings`     | Profile, plan tier, limits                      |
| `/logout`       | Clears cookie, redirects to login               |

## Local Development

The easiest setup path is still the API package helper, which seeds local state and writes `.dev.vars` for both workers:

```sh
pnpm -C packages/api setup
```

Then:

1. **Start the platform API** (needed for usage + secrets):

```sh
pnpm -C packages/api dev
```

2. **Start the dashboard dev server** (separate terminal):

```sh
pnpm -C packages/dashboard dev
```

In `vite.config.ts`, the dashboard points `persistTo` at the API worker state directory and registers the API worker as an auxiliary worker. That keeps local platform state aligned while the dashboard still talks to the platform API for mutations and non-DB reads.

## Source Layout

```
lib/
  api.ts                    # Platform API client (typed fetch wrapper, used for mutations + usage/secrets)
middleware/
  01.auth.ts                # Hyperdrive DB init, JWT cookie extraction, user bootstrap, login redirect
pages/
  layout.vue                # Top bar with nav + user info
  login.vue                 # OAuth login buttons
  login.server.ts           # Builds provider login URLs
  logout.vue                # Cookie clear + redirect
  logout.server.ts
  index.vue                 # Project list + usage cards
  index.server.ts           # Direct DB for projects/domains, API for usage
  settings.vue              # Profile + plan info
  settings.server.ts        # Direct DB for user + plan limits
  auth/
    callback.vue            # OAuth callback (receives token)
    callback.server.ts
  projects/
    [id].vue                # Project detail (all sections)
    [id].server.ts          # Direct DB for project/deployments/domains/resources, API for usage/secrets. Actions for mutations.
```
