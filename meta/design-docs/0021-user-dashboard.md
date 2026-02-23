# User Dashboard

**Date:** 2026-02-22
**Status:** Draft

---

## Summary

A user-facing dashboard for Void, built as a Vue Pages mode app that dogfoods the platform. Provides project management, deployment history, usage monitoring, domain/secrets management, and account settings.

## Architecture

### Package: `packages/dashboard`

- Vue Pages mode app using `voidPlugin()` + `voidVue()`
- Deploys as its own Void project at `dashboard.void.app`
- Tailwind CSS with custom theme from shared preset

### Data Access: BFF via Platform API

Server-side loaders (`<script server>` / `.server.ts`) call the platform API over HTTP using the user's JWT. No direct D1 or Analytics Engine access — the platform remains the single source of truth for all business logic and authorization.

### Auth

OAuth (GitHub/Google) → platform issues JWT → stored in httpOnly cookie → forwarded as Bearer token to platform API in server-side loaders.

### Shared Design System: `packages/ui`

Starts as a Tailwind preset package exporting design tokens. Dashboard components live in `packages/dashboard/components/` initially. When patterns stabilize, mature components are extracted to `packages/ui` as a Vue component library. The admin dashboard (Hono JSX) can adopt the same Tailwind preset to converge on a shared look.

## Pages

| Route                     | Purpose                                                                   | API Calls                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pages/login.vue`         | OAuth buttons, callback handler                                           | —                                                                                                            |
| `pages/layout.vue`        | Top bar (logo, nav links, user info)                                      | —                                                                                                            |
| `pages/index.vue`         | Project list + aggregate usage summary cards                              | `GET /projects`, `GET /usage`                                                                                |
| `pages/projects/[id].vue` | Project detail: overview, deployments, usage, domains, secrets, resources | `GET /projects/:id`, `GET /projects/:id/deployments`, `GET /projects/:id/usage`, `GET /projects/:id/domains` |
| `pages/settings.vue`      | Profile, plan tier + limits, API token                                    | `GET /user` (new endpoint)                                                                                   |

### Home (`pages/index.vue`)

- Project cards grid: name/slug, live URL, mode badge, last deploy timestamp + status, request count
- Aggregate usage bar: total requests / limit, bandwidth, AI neurons with progress toward plan limits
- "New project" CTA linking to CLI docs (`void projects create`)

### Project Detail (`pages/projects/[id].vue`)

Organized in sections or tabs:

- **Overview** — live URL, mode, created date, current deployment status
- **Deployments** — chronological table with status badge (live/failed/pending), commit, source, timestamp. Expandable error messages for failed deploys.
- **Usage** — summary cards for current billing period: requests, bandwidth, AI neurons. Progress bars showing usage vs. plan limits.
- **Domains** — list with status badges (pending/active). Add/remove forms.
- **Secrets** — list variable names (values hidden). Add/edit/delete forms. Values shown only on creation.
- **Resources** — read-only list of bindings (D1, KV, R2, queues) with binding names

### Settings (`pages/settings.vue`)

- Profile info (email, login, OAuth provider)
- Current plan tier + limits breakdown
- API token display/regeneration

## Visual Design

### Palette

| Token            | Value                      |
| ---------------- | -------------------------- |
| Background       | `#16171d`                  |
| Dividers/borders | `#3b3440`                  |
| Text primary     | `#ffffff`                  |
| Text secondary   | `rgba(255, 255, 255, 0.7)` |
| Accent/highlight | `#b39aff`                  |
| Status: live     | green                      |
| Status: pending  | amber                      |
| Status: failed   | red                        |

### Aesthetic

Dark TUI (terminal UI) inspired — dense, information-rich, polished. Not a gimmick; a genuine developer-tool feel.

- Monospace font for data (slugs, IDs, timestamps, usage numbers)
- Sans-serif (system font or Inter) for navigation and headings
- Tight spacing, dense information display
- `1px solid #3b3440` borders. No shadows. Minimal or zero border-radius.
- Tables over cards where data is tabular
- Active/hover states: `#b39aff` with low-opacity backgrounds (`rgba(179, 154, 255, 0.1)`)
- Progress bars: thin, `#b39aff` fill on `#3b3440` track
- Navigation: horizontal top bar, no sidebar

## Directory Structure

```
packages/ui/
  src/
    tailwind-preset.ts       # Shared design tokens
    base.css                 # Base styles (resets, scrollbars)
  package.json

packages/dashboard/
  pages/
    login.vue
    layout.vue
    index.vue
    projects/
      [id].vue
      [id].server.ts
    settings.vue
    settings.server.ts
  middleware/
    01.auth.ts               # JWT cookie check, redirect to login
  components/                # Dashboard UI components
  vite.config.ts
  tailwind.config.ts         # Imports preset from @voidcloud/ui
  package.json
```

## Out of Scope (v1)

- Time-series charts / full observability (p50/p95/p99, per-route breakdowns)
- Team/org features
- Project creation from dashboard (CLI only)
- Deployment rollback
- Log streaming / real-time request tailing
- Dark/light mode toggle (dark only)

## New Platform API Endpoint Needed

- `GET /user` — returns current user profile, plan, billing cycle start, limits
