# @voidcloud/dashboard

User-facing dashboard for Void. Built as a React Pages mode app, dogfooding the
platform.

## Architecture

- **React Pages mode** - `voidPlugin()` + `voidReact()`, SSR with client hydration.
- **API-only data access** - loaders and actions call the platform API. The dashboard
  does not connect to platform Postgres directly.
- **Auth** - OAuth (GitHub/Google) via the platform's `/auth/login` flow. The JWT is
  stored in an httpOnly cookie (`void_token`). Middleware validates the token with
  `GET /me`.
- **Preview gate** - authenticated non-admin users see a gated page while the
  dashboard is rebuilt. Admin users can access the dashboard routes.
- **Styling** - Tailwind CSS v4 with the Void design system from `@voidcloud/ui`
  (VoidZero theme styles, fonts, assets, and React UI primitives).

## Pages

| Route           | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `/login`        | OAuth buttons (GitHub, Google)                  |
| `/`             | Admin-gated project list                        |
| `/projects/:id` | Deployments, usage, domains, secrets, resources |
| `/settings`     | Profile                                         |
| `/logout`       | Clears cookie, redirects to login               |

## Local Development

Run the dashboard against the production API and your real user:

```sh
API_URL=https://api.void.cloud SITE_DOMAIN=void.app pnpm -C packages/dashboard dev
```

Open the local Vite URL and sign in. The production API allows localhost OAuth
redirects and returns the dashboard token to `/auth/callback`.

To run against staging, first get a Cloudflare Access token and pass it through
to the local dashboard worker:

```sh
export CF_ACCESS_TOKEN="$(cloudflared access token -app=https://api.staging.void.cloud)"
API_URL=https://api.staging.void.cloud SITE_DOMAIN=staging.void.app pnpm -C packages/dashboard dev
```

You can also put `API_URL`, `SITE_DOMAIN`, and `CF_ACCESS_TOKEN` in
`packages/dashboard/.dev.vars`. `pnpm dev` refreshes an expired staging
`CF_ACCESS_TOKEN` through `cloudflared` before Vite starts.

To run against a local API instead:

```sh
pnpm -C packages/api setup
pnpm -C packages/api dev
API_URL=http://localhost:8787 SITE_DOMAIN=void.app pnpm -C packages/dashboard dev
```

## Source Layout

```text
lib/
  api.ts                    # Typed platform API client + fetch helpers
middleware/
  01.auth.ts                # void_token validation through /me + admin preview gate
pages/
  layout.tsx                # Top bar with nav + user info
  login.tsx                 # OAuth login buttons
  login.server.ts           # Builds provider login URLs
  logout.tsx
  logout.server.ts          # Cookie clear + redirect
  index.tsx                 # Project list or preview gate
  index.server.ts           # API reads for projects
  settings.tsx              # Profile
  settings.server.ts        # Session user from middleware
  auth/
    callback.tsx
    callback.server.ts      # OAuth callback token/code exchange
  projects/
    [id].tsx                # Project detail
    [id].server.ts          # API reads/actions for project dashboard data
```
