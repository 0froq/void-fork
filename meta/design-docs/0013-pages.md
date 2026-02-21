# Pages: Inertia-Inspired Full-Stack DX for Vite Cloud

## Overview

Pages is a new rendering mode for Vite Cloud that provides an Inertia.js-inspired developer experience: server-driven routing with SPA-like navigation, automatic prop passing from server handlers to page components, form helpers with built-in validation error handling, and full SSR.

The architecture separates a **framework-agnostic core** (protocol, server handling, page resolution) from **framework-specific adapters** (rendering, hydration, client components). Vue is the first adapter; React, Svelte, and Solid follow the same adapter interface.

## Core Concepts

### The Protocol

Pages mode adds an Inertia-style protocol on top of Vite Cloud's existing Hono-based server:

| Request type      | How detected                        | Server response                                           |
| ----------------- | ----------------------------------- | --------------------------------------------------------- |
| Initial page load | No `X-Inertia` header               | Full SSR HTML with embedded page object. Client hydrates. |
| SPA navigation    | `X-Inertia: true` header            | JSON page object. Client swaps component.                 |
| Form submission   | `X-Inertia: true` + POST/PUT/DELETE | Re-run loader (fresh props) or redirect.                  |

**Page object shape:**

```json
{
  "component": "users/index",
  "props": { "users": [...] },
  "shared": { "auth": { "user": {...} }, "flash": null },
  "url": "/users",
  "errors": null
}
```

### Directory Structure

Pages mode activates when a `pages/` directory exists. It coexists with the existing `routes/` directory for pure JSON API endpoints.

```
project/
  pages/                  # Pages mode (Inertia-style UI)
    layout.vue            # Root layout
    index.vue             # GET /
    users/
      layout.vue          # Nested layout for /users/*
      index.vue           # GET /users
      [id].vue            # GET /users/:id
      create.vue          # GET /users/create
  routes/                 # Pure JSON API endpoints (unchanged)
    api/
      health.ts           # GET /api/health -> JSON
      webhooks.ts         # POST /api/webhooks -> JSON
  middleware/              # Shared across pages and routes
    01.auth.ts
```

File-based routing rules match the existing `routes/` conventions: `[param]` for dynamic segments, `[...param]` for catch-all, `(group)/` for route groups.

### No Manual SSR Entry

When pages mode is active, the adapter auto-generates the SSR entry and client hydration entry. No `main.ssr.ts` or `main.client.ts` needed.

## Page Anatomy (Vue Example)

```vue
<!-- pages/users/index.vue -->
<script server lang="ts">
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

// loader provides props for this page
export const loader = defineHandler(async (c) => {
  const users = await db.list("users");
  return { users };
});

// action handles mutations — returns nothing = re-run loader with fresh props
export const action = defineHandler.withValidator({ body: createUserSchema })(async (
  c,
  { body },
) => {
  await db.insert("users", body);
  // implicit: re-runs loader, page re-renders with updated user list
});
</script>

<script setup lang="ts">
import { useForm, useShared, Link } from "@vite-cloud/vue";

interface User {
  id: number;
  name: string;
  email: string;
}
defineProps<{ users: User[] }>();

const { auth, flash } = useShared();

const form = useForm({ name: "", email: "" });
function submit() {
  form.post("/users");
}
</script>

<template>
  <h1>Users</h1>
  <p v-if="flash?.message">{{ flash.message }}</p>

  <ul>
    <li v-for="u in users" :key="u.id">
      <Link :href="`/users/${u.id}`">{{ u.name }}</Link>
    </li>
  </ul>

  <form @submit.prevent="submit">
    <input v-model="form.name" />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>
    <input v-model="form.email" />
    <span v-if="form.errors.email">{{ form.errors.email }}</span>
    <button :disabled="form.processing">Create</button>
  </form>
</template>
```

### Server Handler Rules

The `<script server lang="ts">` block is extracted by the adapter's Vite plugin before the framework's SFC compiler processes the file. It uses the existing `defineHandler` API with Remix-style named exports: `loader` and `action`.

**`loader`:** Handles GET requests. Returns props for the page. Required for any page that needs server data.

**`action`:** Handles all mutations (POST, PUT, PATCH, DELETE). Two return behaviors:

| Returns               | Behavior                                                              |
| --------------------- | --------------------------------------------------------------------- |
| Nothing (void)        | Re-run the page's loader, re-render with fresh props. One round-trip. |
| `c.redirect('/path')` | Navigate to another page. Two round-trips (POST + redirect GET).      |

**Validation errors:** Thrown via `ValidationError` or automatically by `withValidator`. The framework catches the error, re-runs the loader for the current page, and attaches `errors` to the page object. `useForm().errors` picks them up automatically on the client.

### Type Safety

No type codegen needed for page props. The prop interface is defined in the same file:

```vue
<script server lang="ts">
export const loader = defineHandler(async (c) => {
  return { users: await db.list("users") }; // server return type
});
</script>

<script setup lang="ts">
defineProps<{ users: User[] }>(); // client prop type
</script>
```

The type contract is explicit and colocated. The tradeoff is that server return type and client prop type are not statically linked across the two script blocks — but they live in the same file, making drift easy to spot.

## Server Handler Files

### Universal Convention: Companion `.server.ts`

Every framework supports companion `.server.ts` files alongside page components:

```
pages/
  users/
    index.vue             # page component
    index.server.ts       # server handler (optional if using <script server>)
```

```ts
// pages/users/index.server.ts
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

export const loader = defineHandler(async (c) => {
  return { users: await db.list("users") };
});

export const action = defineHandler(async (c) => {
  await db.insert("users", await c.req.json());
});
```

This is the **only** option for React, Svelte, and Solid pages (no SFC custom blocks). For Vue, both `<script server>` and companion `.server.ts` are supported — companion `.server.ts` takes precedence if both exist.

### React Example

```
pages/
  users/
    index.tsx             # page component
    index.server.ts       # server handler
```

```tsx
// pages/users/index.tsx
import { useForm, useShared, Link } from "@vite-cloud/react";

export default function UsersPage({ users }: { users: User[] }) {
  const { auth } = useShared();
  const form = useForm({ name: "", email: "" });

  return (
    <div>
      <ul>
        {users.map((u) => (
          <li key={u.id}>
            <Link href={`/users/${u.id}`}>{u.name}</Link>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.post("/users");
        }}
      >
        <input value={form.name} onChange={(e) => form.setData("name", e.target.value)} />
        {form.errors.name && <span>{form.errors.name}</span>}
        <button disabled={form.processing}>Create</button>
      </form>
    </div>
  );
}
```

## Layouts

Layout files use the `layout.{vue,tsx,svelte}` naming convention in any `pages/` subdirectory.

```
pages/
  layout.vue              # root layout (nav, footer)
  index.vue
  users/
    layout.vue            # nested layout for /users/*
    index.vue
    [id].vue
  admin/
    layout.vue            # admin layout
    index.vue
```

```vue
<!-- pages/layout.vue -->
<script setup>
import { useShared, Link } from "@vite-cloud/vue";
const { auth } = useShared();
</script>

<template>
  <nav>
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <span v-if="auth.user">{{ auth.user.name }}</span>
  </nav>
  <main>
    <slot />
  </main>
</template>
```

**Rules:**

- Layouts **persist across navigations** within their subtree (component state preserved)
- Nested layouts wrap: root `layout.vue` > `users/layout.vue` > page component
- Layouts render client-side only — they access shared data via `useShared()`, not server handlers
- Layouts do **not** have `<script server>` blocks

## Shared Data

Middleware injects shared data available on every page via `c.set('shared', {...})`:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from "vite-cloud";

export default defineMiddleware(async (c, next) => {
  const user = await getSessionUser(c);
  c.set("shared", {
    auth: { user },
    flash: getFlash(c),
  });
  await next();
});
```

Client-side access via `useShared()`:

```vue
<script setup>
import { useShared } from "@vite-cloud/vue";
const { auth, flash } = useShared();
</script>
```

Shared data is merged into every page object response. It is separate from page props — `defineProps` receives page-specific data, `useShared()` receives global data.

## Client-Side API

Each framework adapter exports:

| Export              | Purpose                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Link`              | Component. Renders `<a>`, intercepts clicks for Inertia-style navigation. Props: `href`, `method`, `data`, `preserveScroll`. |
| `useForm(defaults)` | Reactive form helper. Returns `{ data, post, put, patch, delete, processing, errors, isDirty, reset, clearErrors }`.         |
| `useShared()`       | Returns shared data from middleware.                                                                                         |
| `router`            | Programmatic navigation: `router.visit(url)`, `router.post(url, data)`, `router.reload()` (re-fetch current page props).     |

## Server-Side Flow

### Initial Request (GET /users, no X-Inertia header)

1. Run middleware chain -> `c.set('shared', {...})`
2. Resolve page: URL -> `pages/users/index.vue`
3. Run page's `loader` -> props
4. Resolve layout chain: `layout.vue` > `users/layout.vue`
5. SSR render: layouts wrapping page component with props + shared data
6. Return HTML with `<div id="app" data-page='{ component, props, shared, url }'>`
7. Client hydrates

### Inertia Navigation (GET /users, X-Inertia: true)

1. Run middleware chain -> shared data
2. Run page's `loader` -> props
3. Return JSON: `{ component: "users/index", props, shared, url }`
4. Client swaps page component, persists layouts if in same subtree

### Form Submission (POST /users, X-Inertia: true)

1. Run middleware chain
2. Run page's `action`
3. If `ValidationError` thrown -> re-run `loader`, return page object with `errors` attached
4. If action returns nothing -> re-run `loader`, return page object with fresh props
5. If action returns redirect -> return redirect, client follows as Inertia GET

## Architecture: Core vs Adapters

### Core (`vite-cloud` package)

Framework-agnostic. Handles:

- Page object protocol (format, headers, request detection)
- `pages/` directory scanning and file-based route resolution
- Companion `.server.ts` file loading
- Middleware execution and shared data collection
- Handler execution (props / redirect / re-run loader)
- Validation error catching and attachment
- Layout tree resolution from directory structure
- Page object serialization

### Framework Adapter (separate package, e.g. `@vite-cloud/vue`)

Each adapter is a Vite plugin + runtime library. The adapter:

- Includes the framework's Vite plugin as a dependency (e.g. `@vitejs/plugin-vue`)
- Provides framework-specific SFC compilation (e.g. `<script server>` extraction for Vue)
- Generates SSR entry and client hydration entry
- Handles SSR rendering (`renderToString`)
- Handles client-side page mounting, swapping, and layout persistence
- Exports `Link`, `useForm`, `useShared`, `router`

### Plugin Ordering

The adapter's Vite plugin must extract `<script server>` **before** the framework plugin compiles the SFC:

```ts
// @vite-cloud/vue/plugin internals
import vue from "@vitejs/plugin-vue";

export function viteCloudVue(options?) {
  return [
    scriptServerPlugin(), // extract <script server> first
    vue(options?.vue), // then compile the remaining SFC
    pagesPlugin(), // generate SSR + hydration entries
  ];
}
```

### User Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudVue } from "@vite-cloud/vue/plugin";

export default defineConfig({
  plugins: [viteCloud(), ...viteCloudVue()],
});
```

`viteCloudVue()` returns an array of three plugins (scriptServer, vue, pages) — spread it into the plugins array.

### Adapter Interface (As Implemented)

Each framework adapter provides:

1. **Vite plugins** via a factory function (e.g. `viteCloudVue()`) returning an array of plugins
2. **SSR renderer** via `virtual:vite-cloud-pages-renderer` — exports `renderPage(pageObj, assetTags)` that SSR-renders the page with layout wrapping and returns full HTML
3. **Client hydration entry** via `virtual:vite-cloud-pages-client` — hydrates the SSR HTML, sets up the client router, and handles SPA navigation
4. **Runtime exports** via the `/runtime` subpath — `Link`, `useForm`, `useShared` composables/components

The SSR renderer and client entry are generated as virtual modules by the adapter's `pagesPlugin`. They use a component manifest (mapping component IDs to dynamic imports) and a layout tree (mapping component IDs to their ancestor layout IDs) generated from the page scan results.

## Implementation Details

### Route Compilation: `notFound` vs `get("*")`

The page catch-all route uses `app.notFound()` instead of `app.get("*")`. In dev mode, `get("*")` intercepts ALL GET requests including Vite's module pipeline requests (e.g. `/pages/index.vue`, `/@vite/client`), breaking HMR and component loading. `notFound()` only fires when no other handler matches, allowing Vite's middleware to serve source files.

### `run_worker_first` Exclusions for Dev

When pages mode is active, `run_worker_first` must exclude `/pages/*` in addition to the standard `!/@*`, `!/src/*`, `!/node_modules/*`. Without this, module requests for `.vue` files go to the worker first, which returns 404 instead of letting Vite serve them.

### Production Asset Serving

Static assets (`/assets/*`) are excluded from `run_worker_first` so Cloudflare serves them directly from the edge/CDN without invoking the worker. The `notFound` handler also has a fallback to `env.ASSETS.fetch(c.req.raw)` for any other file-extension paths that slip through (e.g. `/favicon.ico`), mirroring the existing SSR codepath's `fetchFromAssets()` pattern.

### Rolldown Hook Filters

All `transform`, `resolveId`, and `load` hooks in adapter plugins use declarative `filter` objects instead of early-return guards. This lets Rolldown evaluate conditions in Rust before crossing the FFI boundary into JavaScript, avoiding unnecessary JS invocations. For example, a `transform` hook can use `filter: { id: { include: /\.vue$/, exclude: /node_modules/ }, code: /<script\s+server\b/ }` — Rolldown skips any module that doesn't match both conditions without ever calling into JS. Dynamic checks (like `id.startsWith(pagesDir)`) that depend on runtime state remain in the handler. All adapter plugins should follow this pattern.

### Source Map Preservation in `<script server>` Stripping

When stripping the `<script server>` block, the adapter plugin replaces the matched text with an equivalent number of newlines (`"\n".repeat(lines - 1)`) rather than an empty string. This preserves line positions for all code after the block, so downstream plugins (SFC compilers, JSX transforms, etc.) see correct line numbers. The transform returns `map: { mappings: "" }` to signal an identity mapping — no position changes relative to the input. Every adapter that extracts `<script server>` blocks must use this technique.

### Client Entry: Virtual Module URL in `<script>` Tags

Browser-facing `<script src>` tags cannot use Vite's `\0`-prefixed virtual module IDs directly. The client entry script tag uses `/@id/__x00__virtual:vite-cloud-pages-client` — Vite's URL-based virtual module resolution format.

### Client-Side Page Updates Must Be Atomic

The client entry must resolve all async work (component loading, layout resolution) via `Promise.all` before updating any reactive state. Setting reactive state across multiple `await` boundaries allows the framework to flush a render between the awaits, causing the new component to render with stale props. The fix: resolve all async work first, then update props → layouts → component synchronously in a single microtask. Props must be set BEFORE the component ref — if the component changes first, the framework renders the new component with stale props from the previous page.

### No Global Click Interceptor — Use `Link` Component

The client entry does NOT include a global `document.addEventListener("click")` interceptor for `<a>` tags. Instead, SPA navigation is handled exclusively by the `Link` component. A global interceptor conflicts with `Link` — both fire `router.visit()` on the same click event, causing double navigation. The `Link` component already handles modifier keys, external URLs, and non-GET methods correctly.

### SSR Context Must Be Complete

During SSR rendering, the app must provide all context keys that components may read (shared data, errors, router), even if the value is `null`. Runtime composables (`useForm`, `Link`) must accept a missing context gracefully (e.g. default to `null`) to avoid framework warnings during SSR when client-only context like the router is unavailable.

## Pitfalls

### Reactive State Update Atomicity

**Problem:** Multiple `await`s between reactive state assignments in the same function:

```js
// BAD — framework flushes renders between the two awaits
currentComponent.value = await resolveComponent(data.component);
currentLayouts.value = await resolveLayouts(data.component); // render happens here!
currentProps.value = data.props; // Too late — component already rendered with old props
```

**Fix:** Resolve all async work first, then batch-update state:

```js
// GOOD — all state updated synchronously after async work completes
const [comp, layouts] = await Promise.all([
  resolveComponent(data.component),
  resolveLayouts(data.component),
]);
currentProps.value = data.props;
currentLayouts.value = layouts;
currentComponent.value = comp;
```

**Rule:** Set props BEFORE component. If the component ref changes, the framework's next render sees the new component. If props haven't been updated yet, the new component renders with stale props from the previous page. This applies to any reactive framework (Vue refs, React state, Svelte stores, Solid signals).

### `app.get("*")` Blocks Vite Dev Server

**Problem:** Hono's `app.get("*", handler)` matches ALL GET requests, not just user-facing navigation. This intercepts Vite's module requests (`/pages/index.vue`, `/@vite/client`, `/node_modules/.vite/deps/vue.js`), returning HTML or 404 instead of JavaScript modules.

**Fix:** Use `app.notFound(handler)` which only fires when no other Hono route or Vite middleware handles the request.

### Worker Catches Static Asset Requests in Production

**Problem:** With `run_worker_first: ["/**"]` and no exclusions, ALL requests go to the worker, including requests for JS/CSS bundles in `/assets/`. This is both slow (unnecessary worker invocation) and broken if the `notFound` handler returns a plain 404.

**Fix:** Exclude `/assets/*` from `run_worker_first` so Cloudflare serves hashed assets directly from the edge. Additionally, the `notFound` handler calls `env.ASSETS.fetch(c.req.raw)` for any remaining file-extension paths as a fallback.

### Bare Module Specifiers in Inline `<script>` Tags

**Problem:** Inline `<script type="module">import "virtual:foo";</script>` in SSR-generated HTML doesn't work — browsers don't resolve bare module specifiers, and Vite's import rewriting only processes files served through its module pipeline.

**Fix:** Either use `<script type="module" src="/@id/__x00__virtual:foo">` (served through Vite) or don't inject inline module scripts in SSR HTML.

## Debugging Techniques

### Browser Console Forwarding

For debugging client-side issues during development, [vite-console-forward-plugin](https://github.com/mitsuhiko/vite-console-forward-plugin) forwards browser console output to the terminal. Note: its `transformIndexHtml` hook does NOT fire for SSR-generated HTML — you must manually inject `<script type="module" src="/@id/__x00__virtual:console-forward">` into the SSR head tags. The plugin's endpoint must also use a `/@`-prefixed path (e.g. `/@console-forward`) to bypass `run_worker_first` routing.

### Headless Playwright for Client-Side Bug Reproduction

For systematic client-side debugging (hydration crashes, stale props, navigation bugs), use Playwright in headless mode:

```js
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("console", (msg) => console.log(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => console.log(`[ERROR] ${err.message}`));

await page.goto("http://localhost:5173/");
await page.click('a[href="/users"]');
// Check URL, content, and console for warnings
```

This captures framework warnings, hydration errors, and JavaScript exceptions that only appear in the browser — not in server logs. Run the script from the monorepo root (where `playwright` is installed).

### Isolating Dev vs Production Bugs

If something works in `vite dev` but breaks in `vite preview`:

1. Check `run_worker_first` patterns — dev exclusions like `!/pages/*` are irrelevant in production since those paths don't exist
2. Check the `notFound` handler — it must fall through to `env.ASSETS.fetch()` for static files
3. Check virtual module URLs — dev uses `/@id/__x00__` prefix, production uses hashed filenames from the manifest

If something works in `vite preview` but breaks in `vite dev`:

1. Check that `run_worker_first` excludes source directories (`!/pages/*`, `!/src/*`)
2. Check that Hono routes don't intercept Vite middleware requests (use `notFound` instead of `get("*")`)
3. Check that virtual module script tags use `/@id/__x00__` prefix for browser-facing URLs

## What This Does NOT Include

- **Partial reloads** (Inertia's `only` / `except` for selective prop fetching) — can be added later
- **Link prefetching** (prefetch on hover) — can be added later
- **View transitions API** integration — can be added later
- **Asset versioning** (409 + full reload on bundle changes) — can be added later
- **Flash data helpers** — flash messages work via shared data, no special API needed initially
