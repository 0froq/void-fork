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

# Layouts & Shared Data

## Layouts

Place a layout file in any `pages/` directory to wrap all pages in that subtree:

```
pages/
  layout.(tsx|vue|svelte)     # Root layout (nav, footer)
  index.(tsx|vue|svelte)
  users/
    layout.(tsx|vue|svelte)   # Nested layout for /users/*
    index.(tsx|vue|svelte)
    [id].(tsx|vue|svelte)
```

::: code-group

```tsx [React]
// pages/layout.tsx
import { useShared, Link } from "void/react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const { auth } = useShared();
  return (
    <>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/users">Users</Link>
        {auth?.user && <span>{auth.user.name}</span>}
      </nav>
      <main>{children}</main>
    </>
  );
}
```

```vue [Vue]
<!-- pages/layout.vue -->
<script setup lang="ts">
import { useShared, Link } from "void/vue";
const { auth } = useShared();
</script>

<template>
  <nav>
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <span v-if="auth?.user">{{ auth.user.name }}</span>
  </nav>
  <main>
    <slot />
  </main>
</template>
```

```svelte [Svelte]
<!-- pages/layout.svelte -->
<script>
  import { useShared, Link } from "void/svelte";
  let { children } = $props();
  const { auth } = useShared();
</script>

<nav>
  <Link href="/">Home</Link>
  <Link href="/users">Users</Link>
  {#if auth?.user}<span>{auth.user.name}</span>{/if}
</nav>
<main>
  {@render children()}
</main>
```

```tsx [Solid]
// pages/layout.tsx
import { useShared, Link } from "void/solid";
import type { JSX } from "solid-js";

export default function Layout(props: { children: JSX.Element }) {
  const shared = useShared<{ auth: { user: { name: string } | null } }>();
  return (
    <>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/users">Users</Link>
        {shared.auth?.user && <span>{shared.auth.user.name}</span>}
      </nav>
      <main>{props.children}</main>
    </>
  );
}
```

:::

Layouts nest automatically (e.g. root layout wraps `users/layout` wraps page component) and persist across navigations within their subtree — component state is preserved.

## Named Layouts

Named layouts let individual pages opt into a different layout without changing the URL structure. Define them in `_layouts/` directories within `pages/`:

```
pages/
  _layouts/
    landing.vue           # named "landing"
    post.vue              # named "post"
  layout.vue              # default root layout
  index.vue
  blog/
    hello.md              # layout: post
    archive.md            # layout: landing
  pricing.vue             # layout: !landing (exclusive)
```

### Selecting a named layout

Export a `layout` constant from any page:

::: code-group

```tsx [React]
export const layout = "landing";

export default function Page() {
  return <div>This page uses the landing layout</div>;
}
```

```vue [Vue]
<script setup>
export const layout = "landing";
</script>

<template>
  <div>This page uses the landing layout</div>
</template>
```

```svelte [Svelte]
<script context="module">
export const layout = "landing";
</script>

<div>This page uses the landing layout</div>
```

```tsx [Solid]
export const layout = "landing";

export default function Page() {
  return <div>This page uses the landing layout</div>;
}
```

:::

For markdown pages, use frontmatter:

```md
---
layout: post
---

# My Blog Post
```

### Layout modes

| Value        | Behavior                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| `"landing"`  | Replace the innermost layout in the chain. Outer ancestor layouts still apply. |
| `"!landing"` | Replace the **entire** chain. Only the named layout wraps the page.            |
| `false`      | No layout wrapping at all. Page renders standalone.                            |

"Innermost" means the deepest layout in the resolved chain. If the chain is `[root, docs/layout]`, the named layout replaces `docs/layout`. If the chain is only `[root]`, it replaces root.

### Resolution order

When a page specifies `layout: "post"`, the scanner walks up the directory tree to find `_layouts/post`:

```
pages/guide/intro.md  (layout: post)

1. pages/guide/_layouts/post.vue  → not found
2. pages/_layouts/post.vue        → found ✓
```

Closest ancestor wins, same as default layout chain. If no matching named layout is found in any ancestor, the build fails with a clear error.

### Examples

**Blog with shared nav but post-specific layout:**

```
pages/
  _layouts/
    post.vue              # sidebar, date, author
  layout.vue              # nav + footer
  blog/
    layout.vue            # blog sidebar
    hello.md              # layout: post → chain: [root, _layouts/post]
    archive.vue           # (no layout) → chain: [root, blog/layout]
```

`layout: post` on `blog/hello.md` replaces the innermost default layout (`blog/layout`) with `_layouts/post`. The root layout still wraps.

**Fullscreen page with no layout:**

::: code-group

```tsx [React]
export const layout = false;

export default function Landing() {
  return (
    <div className="hero fullscreen">
      <h1>Welcome</h1>
    </div>
  );
}
```

```vue [Vue]
<script setup>
export const layout = false;
</script>

<template>
  <div class="hero fullscreen"><h1>Welcome</h1></div>
</template>
```

:::

**Exclusive layout (skip all ancestors):**

```md
---
layout: "!landing"
---

# Standalone Landing Page
```

Only `_layouts/landing` wraps this page — the root layout is skipped entirely.

## Shared Data

Middleware can inject data available on every page via `c.set("shared", {...})`. Augment `CloudContextVariables` to type the shared data, and `useShared()` will infer the type automatically:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from "void";

declare module "void" {
  interface CloudContextVariables {
    shared: { auth: { user: { name: string } | null } };
  }
}

export default defineMiddleware(async (c, next) => {
  const user = await getSessionUser(c);
  c.set("shared", { auth: { user } });
  await next();
});
```

Access it on the client with `useShared()` — the return type is inferred from your augmentation:

::: code-group

```tsx [React]
import { useShared } from "void/react";

export default function Page() {
  const { auth } = useShared(); // { auth: { user: { name: string } | null } }
  return <p>Hello, {auth?.user?.name}</p>;
}
```

```vue [Vue]
<script setup lang="ts">
import { useShared } from "void/vue";
const { auth } = useShared(); // { auth: { user: { name: string } | null } }
</script>
```

```svelte [Svelte]
<script>
  import { useShared } from "void/svelte";
  const { auth } = useShared(); // { auth: { user: { name: string } | null } }
</script>
```

```tsx [Solid]
import { useShared } from "void/solid";

export default function Page() {
  const shared = useShared(); // { auth: { user: { name: string } | null } }
  return <p>Hello, {shared.auth?.user?.name}</p>;
}
```

:::

Shared data is separate from page props — props come from the loader, `useShared()` returns global data from middleware. See [Type Safety](../type-safety.md#context-variables) for more on augmenting `CloudContextVariables`.
