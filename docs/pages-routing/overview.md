---
outline: deep
---

<script setup>
import { onMounted, nextTick } from 'vue'
onMounted(() => {
  const key = 'vitepress:code-group-tab'
  const saved = localStorage.getItem(key)
  if (saved) nextTick(() => syncAll(saved))
  window.addEventListener('click', (e) => {
    const label = e.target.closest?.('.vp-code-group .tabs label')
    if (!label) return
    const title = label.getAttribute('data-title')
    if (title) {
      localStorage.setItem(key, title)
      const rect = label.getBoundingClientRect()
      syncAll(title)
      const shift = label.getBoundingClientRect().top - rect.top
      if (shift) window.scrollBy(0, shift)
    }
  })
  function syncAll(title) {
    document.querySelectorAll('.vp-code-group').forEach((group) => {
      const label = group.querySelector(`.tabs label[data-title="${title}"]`)
      if (!label) return
      const input = group.querySelector(`#${CSS.escape(label.getAttribute('for'))}`)
      if (!input || input.checked) return
      const i = Array.from(group.querySelectorAll('.tabs input')).indexOf(input)
      const blocks = group.querySelector('.blocks')
      if (!blocks || i < 0) return
      input.checked = true
      const current = blocks.querySelector('.active')
      if (current) current.classList.remove('active')
      blocks.children[i]?.classList.add('active')
    })
  }
})
</script>

# Pages Routing

Pages routing provides the server-rendered, components-as-pages, collocated-data-loading routing system that is seen in many existing JavaScript meta frameworks. However, pages routing in Void is different from most in that it is **rendering framework agnostic.** It is built on patterns inspired by [Inertia.js](https://inertiajs.com/): The server returns the data, and the component receives it as props. The client-side routing logic is minimal, allowing Void to support any rendering framework Vite can support. Today, React, Vue, Svelte, and Solid have first-party adapters.

Pages mode activates when a `pages/` directory exists. It coexists with `routes/` — use `pages/` for UI pages and `routes/` for APIs. Components in `pages/` will be server-rendered, which means **they will run in both Cloudflare Workers and browsers**.

Pages mode is also entirely optional - you can use any client-side router to build a pure client-side SPA that interacts with the backend API via the [typed fetch](../typed-fetch.md) utility.

## Setup

Install a framework adapter alongside `void`:

::: code-group

```sh [React]
npm install @void-x/react
```

```sh [Vue]
npm install @void-x/vue
```

```sh [Svelte]
npm install @void-x/svelte
```

```sh [Solid]
npm install @void-x/solid
```

:::

Add both plugins to your Vite config:

::: code-group

```ts [React]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void-x/react";

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

```ts [Vue]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidVue } from "@void-x/vue";

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

```ts [Svelte]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSvelte } from "@void-x/svelte";

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

```ts [Solid]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSolid } from "@void-x/solid";

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

:::

That's it — no SSR entry, no client entry, no hydration boilerplate. The adapter generates everything.

Each adapter plugin includes the framework's Vite plugin (`@vitejs/plugin-react`, `@vitejs/plugin-vue`, `@sveltejs/vite-plugin-svelte`, `vite-plugin-solid`) so you don't need to install or configure it separately. Pass framework plugin options via `voidReact({ react: { ... } })`, `voidVue({ vue: { ... } })`, `voidSvelte({ svelte: { ... } })`, or `voidSolid({ solid: { ... } })` if needed.

## How Navigation Works

Pages uses an Inertia-style protocol under the hood:

| Request               | Response                                                              |
| --------------------- | --------------------------------------------------------------------- |
| Initial page load     | Full SSR HTML. Client hydrates automatically.                         |
| Subsequent navigation | JSON with component name + props. Client component swap or re-render. |
| Form submission       | Runs action, then returns fresh props or a redirect.                  |

This means the first page load is server-rendered for SEO and performance, and all subsequent navigations feel instant — no full page reloads.

Use the `Link` component for SPA navigation between pages. It renders an `<a>` tag that intercepts clicks and navigates without a full page reload:

::: code-group

```tsx [React]
import { Link } from "void/react";

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

```vue [Vue]
<script setup lang="ts">
import { Link } from "void/vue";
</script>

<template>
  <Link href="/users">Users</Link>
  <Link :href="`/users/${id}`">View</Link>
</template>
```

```svelte [Svelte]
<script>
  import { Link } from "void/svelte";
</script>

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

```tsx [Solid]
import { Link } from "void/solid";

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

:::

For programmatic navigation, use `useRouter()`:

```ts
import { useRouter } from "void/vue"; // or "void/react", "void/svelte", "void/solid"

const router = useRouter();
router.visit("/users");
router.reload(); // re-fetch current page props
router.post("/logout"); // non-GET navigation
```

## Directory Structure

Each page is a component file paired with a `.server.ts` file that provides server-side data loading. Pages can be flat files (`about.vue`) or use directory-based routing (`about/index.vue`) — both map to the same route:

```
project/
  pages/                      # UI pages (SSR + SPA navigation)
    layout.(tsx|vue|svelte)   # Root layout
    index.(tsx|vue|svelte)    # GET /
    index.server.ts           # Server handler for /
    about.(tsx|vue|svelte)    # GET /about (flat file)
    about.server.ts           # Server handler for /about
    users/
      layout.(tsx|vue|svelte) # Nested layout for /users/*
      index.(tsx|vue|svelte)  # GET /users (directory-based)
      index.server.ts         # Server handler for /users
      [id].(tsx|vue|svelte)   # GET /users/:id
      [id].server.ts          # Server handler for /users/:id
  routes/                     # Pure JSON API endpoints
    api/
      health.ts               # GET /api/health -> JSON
  middleware/                 # Shared across pages and routes
    01.auth.ts
```

File-based routing rules are the same as [server routing](../server-routing.md): `[param]` for dynamic segments, `[...param]` for catch-all, `(group)/` for route groups.
