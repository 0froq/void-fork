# @voidcloud/dashboard

User-facing dashboard for Void. Built as a Vue Pages mode app, dogfooding the platform.

## Architecture

- **Vue Pages mode** — `voidPlugin()` + `voidVue()`, SSR with client hydration
- **Direct D1 for reads** — loaders query the shared API database directly via Drizzle (projects, deployments, domains, resources, user profile). Non-D1 reads (usage metrics via Analytics Engine, secrets via CF API) still go through the platform API over HTTP.
- **API for mutations** — all write operations (add/remove domain, set/remove secret) go through the platform API.
- **Auth** — OAuth (GitHub/Google) via the platform's `/auth/login` flow. JWT stored in an httpOnly cookie (`void_token`). Middleware extracts `userId` from the JWT and initializes a Drizzle DB instance from the D1 binding.
- **Styling** — Tailwind CSS v4 with shared design tokens from `@voidcloud/ui`. Dark TUI aesthetic.

## Pages

| Route           | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `/login`        | OAuth buttons (GitHub, Google)                  |
| `/`             | Project list + aggregate usage summary          |
| `/projects/:id` | Deployments, usage, domains, secrets, resources |
| `/settings`     | Profile, plan tier, limits                      |
| `/logout`       | Clears cookie, redirects to login               |

## Local Development

The easiest way is to run the setup script from the API package, which seeds the DB and creates `.dev.vars` for both the API and dashboard:

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

The dashboard shares the API's local D1 state via the `persistTo` option in `vite.config.ts`, so both workers read from the same SQLite file in dev.

## Source Layout

```
lib/
  api.ts                    # Platform API client (typed fetch wrapper, used for mutations + usage/secrets)
middleware/
  01.auth.ts                # D1 init, JWT cookie extraction, userId extraction, login redirect
pages/
  layout.vue                # Top bar with nav + user info
  login.vue                 # OAuth login buttons
  logout.vue                # Cookie clear + redirect
  logout.server.ts
  index.vue                 # Project list + usage cards
  index.server.ts           # Direct D1 for projects, API for usage
  settings.vue              # Profile + plan info
  settings.server.ts        # Direct D1 for user + plan limits
  auth/
    callback.vue            # OAuth callback (receives token)
    callback.server.ts
  projects/
    [id].vue                # Project detail (all sections)
    [id].server.ts          # Direct D1 for project/deployments/domains/resources, API for usage/secrets. Actions for mutations.
```
