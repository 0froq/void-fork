# Vue Pages Playground

Vue full-stack app demonstrating Void's Inertia-inspired Pages mode with SSR, `<script server>` blocks, form handling, and layout nesting.

## Structure

```
pages/
  layout.vue                # Root layout with nav bar and useShared()
  index.vue                 # Home page with <script server> loader
  users/
    index.vue               # Users list + add-user form with action handler
    [id].vue                # Dynamic user detail page
    [id].server.ts          # Co-located server handler for [id] page
routes/api/
  health.ts                 # Health check endpoint (GET /api/health)
middleware/
  01.shared.ts              # Sets shared context data (appName)
migrations/
  001_create_users.sql      # Users table schema
```

## Features

- **File-based page routing** — `.vue` files in `pages/` auto-create routes
- **`<script server>` blocks** — co-located server handlers inside Vue SFCs:
  - `loader()` returns props on GET (read-only data fetching)
  - `action()` handles mutations on POST/PUT (form submissions)
  - type declarations (`interface`, `type`, `import type`) are preserved for `<script setup>`
- **Companion `.server.ts` files** — alternative to `<script server>` for co-located handlers (see `users/[id].server.ts`)
- **SSR + client hydration** — initial load returns SSR HTML; subsequent navigations return JSON via Pages protocol (`X-VoidPages` header)
- **Layout nesting** — `layout.vue` wraps child pages with shared nav using `<slot />`
- **`useForm` composable** — form state management with `isDirty`, `processing`, `wasSuccessful`, `recentlySuccessful`, `errors`, `form.post()` / `form.put()`
- **`useShared` composable** — accesses middleware-set shared data (e.g. `appName` set in `01.shared.ts`)
- **`Link` component** — SPA navigation (renders `<a>` for GET, `<button>` for non-GET methods)
- **`ValidationError`** — throw from `action()` to surface field-level validation errors to the form
- **API route coexistence** — regular `routes/api/` routes work alongside pages
