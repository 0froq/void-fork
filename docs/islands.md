---
outline: deep
---

<script setup>
import { onMounted } from 'vue'
onMounted(() => {
  const key = 'vitepress:code-group-tab'
  const saved = localStorage.getItem(key)
  if (saved) syncAll(saved)
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

# Islands

Islands mode is a partial hydration architecture inspired by [Astro](https://docs.astro.build/en/concepts/islands/). Instead of hydrating the entire page on the client, only the interactive components — "islands" — ship JavaScript to the browser. The rest of the page stays as static, server-rendered HTML.

This gives you the best of both worlds: fast initial page loads with minimal client-side JavaScript, plus rich interactivity exactly where you need it.

::: tip Prerequisites
Islands mode builds on top of [Pages Routing](./pages-routing.md). You need a working Pages setup (framework adapter installed, `pages/` directory, Vite config) before using islands.
:::

## When to Use Islands

Islands mode is a good fit when:

- **Most of your page is static content** — blog posts, marketing pages, documentation
- **Only a few components need interactivity** — a counter, a form, a live widget
- **Performance is critical** — you want near-zero JavaScript for static content

If your entire page is interactive (dashboards, apps with lots of client state), stick with regular [Pages Routing](./pages-routing.md).

## Creating an Island Page

Name your page file with the `.island` suffix:

::: code-group

```txt [React]
pages/
  blog/
    index.island.tsx     # ← island page
    index.server.ts
    _Counter.tsx          # regular component, used as island
    _PostForm.tsx
```

```txt [Vue]
pages/
  blog/
    index.island.vue     # ← island page
    index.server.ts
    _Counter.vue
    _PostForm.vue
```

```txt [Svelte]
pages/
  blog/
    index.island.svelte  # ← island page
    index.server.ts
    _Counter.svelte
    _PostForm.svelte
```

```txt [Solid]
pages/
  blog/
    index.island.tsx     # ← island page
    index.server.ts
    _Counter.tsx
    _PostForm.tsx
```

:::

The `.island` suffix tells Void to:

1. **Server-render the full page** as static HTML (no `data-page` attribute, no client-side router)
2. **Only hydrate** the components you explicitly mark as islands
3. **Skip the Inertia protocol** — navigation between island pages uses full-page loads

## Marking Components as Islands

Use [import attributes](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with) to mark which components should be interactive on the client:

::: code-group

```tsx [React]
// pages/blog/index.island.tsx
import Counter from "./_Counter" with { island: "load" };
import PostForm from "./_PostForm" with { island: "visible" };

export default function BlogIndex({ posts }) {
  return (
    <div>
      <h1>Blog</h1>
      <Counter />
      {posts.map((post) => (
        <a key={post.slug} href={`/blog/${post.slug}`}>
          {post.title}
        </a>
      ))}
      <PostForm />
    </div>
  );
}
```

```vue [Vue]
<!-- pages/blog/index.island.vue -->
<script setup>
import Counter from "./_Counter.vue" with { island: "load" };
import PostForm from "./_PostForm.vue" with { island: "visible" };

defineProps({ posts: Array });
</script>

<template>
  <div>
    <h1>Blog</h1>
    <Counter />
    <a v-for="post in posts" :key="post.slug" :href="`/blog/${post.slug}`">
      {{ post.title }}
    </a>
    <PostForm />
  </div>
</template>
```

```svelte [Svelte]
<!-- pages/blog/index.island.svelte -->
<script>
import Counter from "./_Counter.svelte" with { island: "load" };
import PostForm from "./_PostForm.svelte" with { island: "visible" };

let { posts } = $props();
</script>

<div>
  <h1>Blog</h1>
  <Counter />
  {#each posts as post}
    <a href="/blog/{post.slug}">{post.title}</a>
  {/each}
  <PostForm />
</div>
```

```tsx [Solid]
// pages/blog/index.island.tsx
import Counter from "./_Counter" with { island: "load" };
import PostForm from "./_PostForm" with { island: "visible" };
import { For } from "solid-js";

export default function BlogIndex(props) {
  return (
    <div>
      <h1>Blog</h1>
      <Counter />
      <For each={props.posts}>{(post) => <a href={`/blog/${post.slug}`}>{post.title}</a>}</For>
      <PostForm />
    </div>
  );
}
```

:::

Components imported _without_ the `island` attribute are rendered as static HTML only — no JavaScript is sent to the browser for them.

::: warning TypeScript configuration
Import attributes require `"module": "ESNext"` in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "ESNext"
  }
}
```

:::

## Hydration Strategies

The `island` attribute value controls _when_ the component hydrates:

| Strategy          | Hydrates when...            | Use case                                   |
| ----------------- | --------------------------- | ------------------------------------------ |
| `"load"`          | Page loads                  | Critical interactive UI (forms, nav menus) |
| `"visible"`       | Element enters the viewport | Below-the-fold content                     |
| `"idle"`          | Browser is idle             | Non-critical enhancements                  |
| `"media:(query)"` | CSS media query matches     | Responsive components (e.g., mobile-only)  |

```tsx
import CookieBanner from "./_CookieBanner" with { island: "idle" };
import MobileMenu from "./_MobileMenu" with { island: "media:(max-width: 768px)" };
import Comments from "./_Comments" with { island: "visible" };
```

## Server Handlers

Island pages use the same `loader` and `action` pattern as regular pages. The `.server.ts` companion file works identically:

```ts
// pages/blog/index.server.ts
import { defineHandler } from "void";

export const loader = defineHandler((c) => {
  return c.json({ posts: getAllPosts() });
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json();
  // validate, create post...
  return c.json({ success: true });
});
```

The key difference: when a regular page action succeeds, the Inertia protocol redirects and the client-side router fetches fresh props as JSON. In island pages, there is no client-side router — successful actions result in a full page reload or redirect via `window.location`.

## Forms

Island pages cannot use `useForm` (which depends on the client-side router). Use `useIslandForm` instead — it has the same API but uses `fetch()` directly:

::: code-group

```tsx [React]
import { useIslandForm } from "void/react";

export default function PostForm() {
  const form = useIslandForm({ title: "", body: "" });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post("/blog");
      }}
    >
      <label htmlFor="title">Title:</label>
      <input
        id="title"
        value={form.data.title}
        onChange={(e) => form.setData("title", e.target.value)}
      />
      {form.errors.title && <span>{form.errors.title}</span>}

      <label htmlFor="body">Body:</label>
      <textarea
        id="body"
        value={form.data.body}
        onChange={(e) => form.setData("body", e.target.value)}
      />
      {form.errors.body && <span>{form.errors.body}</span>}

      <button disabled={form.processing}>{form.processing ? "Saving..." : "Add Post"}</button>
    </form>
  );
}
```

```vue [Vue]
<script setup>
import { useIslandForm } from "void/vue";

const form = useIslandForm({ title: "", body: "" });

function submit() {
  form.post("/blog");
}
</script>

<template>
  <form @submit.prevent="submit">
    <label for="title">Title:</label>
    <input id="title" v-model="form.data.title" />
    <span v-if="form.errors.title">{{ form.errors.title }}</span>

    <label for="body">Body:</label>
    <textarea id="body" v-model="form.data.body" />
    <span v-if="form.errors.body">{{ form.errors.body }}</span>

    <button :disabled="form.processing">
      {{ form.processing ? "Saving..." : "Add Post" }}
    </button>
  </form>
</template>
```

```svelte [Svelte]
<script>
import { useIslandForm } from "void/svelte";

const form = useIslandForm({ title: "", body: "" });

function submit() {
  form.post("/blog");
}
</script>

<form on:submit|preventDefault={submit}>
  <label for="title">Title:</label>
  <input id="title" bind:value={form.data.title} />
  {#if form.errors.title}<span>{form.errors.title}</span>{/if}

  <label for="body">Body:</label>
  <textarea id="body" bind:value={form.data.body} />
  {#if form.errors.body}<span>{form.errors.body}</span>{/if}

  <button disabled={form.processing}>
    {form.processing ? "Saving..." : "Add Post"}
  </button>
</form>
```

```tsx [Solid]
import { useIslandForm } from "void/solid";
import { Show } from "solid-js";

export default function PostForm() {
  const form = useIslandForm({ title: "", body: "" });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post("/blog");
      }}
    >
      <label for="title">Title:</label>
      <input
        id="title"
        value={form.data.title}
        onInput={(e) => form.setData("title", e.target.value)}
      />
      <Show when={form.errors.title}>
        <span>{form.errors.title}</span>
      </Show>

      <label for="body">Body:</label>
      <textarea
        id="body"
        value={form.data.body}
        onInput={(e) => form.setData("body", e.target.value)}
      />
      <Show when={form.errors.body}>
        <span>{form.errors.body}</span>
      </Show>

      <button disabled={form.processing}>{form.processing ? "Saving..." : "Add Post"}</button>
    </form>
  );
}
```

:::

`useIslandForm` returns the same shape as `useForm`:

| Property                  | Type                     | Description                                |
| ------------------------- | ------------------------ | ------------------------------------------ |
| `data`                    | `T`                      | Reactive form state                        |
| `setData(field, value)`   | Function                 | Update a field                             |
| `errors`                  | `Record<string, string>` | Validation errors from 422 responses       |
| `processing`              | `boolean`                | Submission in progress                     |
| `isDirty`                 | `boolean`                | Form has unsaved changes                   |
| `wasSuccessful`           | `boolean`                | Last submission succeeded                  |
| `recentlySuccessful`      | `boolean`                | Success within last 2 seconds              |
| `reset(...fields?)`       | Function                 | Reset to defaults (all or specific fields) |
| `clearErrors(...fields?)` | Function                 | Clear errors (all or specific fields)      |
| `post(url)`               | Function                 | Submit via POST                            |
| `put(url)`                | Function                 | Submit via PUT                             |
| `patch(url)`              | Function                 | Submit via PATCH                           |
| `delete(url)`             | Function                 | Submit via DELETE                          |

On success (200), the page reloads. On validation error (422), `errors` is populated from the response `{ errors: { field: "message" } }`. On redirect, the browser follows it.

## Navigation

Island pages do not have a client-side router. Use regular `<a>` tags for navigation:

```tsx
// ✅ Use regular links in island pages
<a href="/blog/my-post">Read more</a>

// ❌ Don't use <Link> — there's no client-side router to handle it
<Link href="/blog/my-post">Read more</Link>
```

When navigating _from_ a regular page to an island page (e.g., via `<Link>`), the router detects that the target is an island page and falls back to a full-page navigation automatically.

## Layouts

Island pages support [layouts](./pages-routing.md#layouts) the same way as regular pages. The layout wraps the page during server rendering. However, layout components in island pages are **static only** — they are not hydrated on the client.

## Mixing Island and Regular Pages

Island pages and regular pages can coexist in the same app:

```txt
pages/
  index.tsx              # regular page (full hydration, client-side router)
  about.tsx              # regular page
  blog/
    index.island.tsx     # island page (partial hydration, static HTML)
    [slug].island.tsx    # island page
```

The client-side router handles navigation between regular pages. Navigating to or from an island page triggers a full-page load.
