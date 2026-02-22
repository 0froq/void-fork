# @vite-cloud/dashboard

User-facing dashboard for Vite Cloud. Built as a Vue Pages mode app, dogfooding the platform.

## Architecture

- **Vue Pages mode** — `viteCloud()` + `viteCloudVue()`, SSR with client hydration
- **BFF pattern** — server-side loaders call the platform API over HTTP using the user's JWT. No direct D1 or Analytics Engine access.
- **Auth** — OAuth (GitHub/Google) via the platform's `/auth/login` flow. JWT stored in an httpOnly cookie (`vc_token`), forwarded as Bearer token in loaders.
- **Styling** — Tailwind CSS v4 with shared design tokens from `@vite-cloud/ui`. Dark TUI aesthetic.

## Pages

| Route           | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `/login`        | OAuth buttons (GitHub, Google)                  |
| `/`             | Project list + aggregate usage summary          |
| `/projects/:id` | Deployments, usage, domains, secrets, resources |
| `/settings`     | Profile, plan tier, limits                      |
| `/logout`       | Clears cookie, redirects to login               |

## Local Development

1. **Build dependencies** (from repo root):

```sh
pnpm -C packages/vite-cloud build
pnpm -C packages/vue build
```

2. **Start the platform API** (separate terminal):

```sh
pnpm -C packages/platform dev
```

3. **Start the dashboard dev server:**

```sh
pnpm -C packages/dashboard dev
```

The dashboard loaders call the platform API at `PLATFORM_API_URL` (defaults to `https://platform.vite.cloud`). For local dev, set this in your wrangler config or environment to point at `http://localhost:8787`.

## Source Layout

```
lib/
  api.ts                    # Platform API client (typed fetch wrapper)
middleware/
  01.auth.ts                # JWT cookie extraction, login redirect
pages/
  layout.vue                # Top bar with nav + user info
  login.vue                 # OAuth login buttons
  logout.vue                # Cookie clear + redirect
  logout.server.ts
  index.vue                 # Project list + usage cards
  index.server.ts
  settings.vue              # Profile + plan info
  settings.server.ts
  auth/
    callback.vue            # OAuth callback (receives token)
    callback.server.ts
  projects/
    [id].vue                # Project detail (all sections)
    [id].server.ts          # Loader + action (domains, secrets)
```
