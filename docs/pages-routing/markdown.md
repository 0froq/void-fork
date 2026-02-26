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

# Markdown

Markdown pages let you use `.md` files as first-class pages in Void's file-based routing. They compile to static HTML at build time with zero client JavaScript, integrate with the layout chain, and can embed interactive framework components as [islands](../islands).

The `@void-x/md` package is opt-in — projects that don't install it pay nothing.

## Setup

Install `@void-x/md` alongside your framework adapter:

::: code-group

```sh [React]
npm install @void-x/md @void-x/react
```

```sh [Vue]
npm install @void-x/md @void-x/vue
```

```sh [Svelte]
npm install @void-x/md @void-x/svelte
```

```sh [Solid]
npm install @void-x/md @void-x/solid
```

:::

Add the plugin to your Vite config **after** the framework adapter:

::: code-group

```ts [React]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void-x/react";
import { voidMarkdown } from "@void-x/md";

export default defineConfig({
  plugins: [voidPlugin(), voidReact(), voidMarkdown()],
});
```

```ts [Vue]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidVue } from "@void-x/vue";
import { voidMarkdown } from "@void-x/md";

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), voidMarkdown()],
});
```

```ts [Svelte]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSvelte } from "@void-x/svelte";
import { voidMarkdown } from "@void-x/md";

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte(), voidMarkdown()],
});
```

```ts [Solid]
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidSolid } from "@void-x/solid";
import { voidMarkdown } from "@void-x/md";

export default defineConfig({
  plugins: [voidPlugin(), voidSolid(), voidMarkdown()],
});
```

:::

That's it. Any `.md` file in `pages/` is now a routable page.

## Page Anatomy

A markdown page has three optional parts: a script block, frontmatter, and the body.

```md
<script>
import Counter from "../components/Counter.vue" with { island: "visible" }
</script>

---

title: Getting Started
description: Learn how to use Void

---

# Getting Started

Welcome to Void. Here's an interactive demo:

<Counter />
```

- **`<script>` block** — extracted before markdown compilation. Import components using the same `with { island: "..." }` syntax as [island pages](../islands). Components must be Uppercase.
- **Frontmatter** — YAML metadata between `---` fences. Accessible in layouts via [`useFrontmatter()`](#frontmatter-access).
- **Body** — standard markdown + GFM. Uppercase tags (`<Counter />`) reference imported components and render as islands.

## File Structure

Markdown pages live in `pages/` alongside regular pages and route the same way:

```
pages/
  layout.island.vue
  index.island.vue
  docs/
    layout.island.vue        # docs layout (sidebar, TOC)
    getting-started.md
    configuration.md
    guides/
      deployment.md
```

A `.md` file inherits layouts, supports companion `.server.ts` files for dynamic data, and auto-prerenders when static — the same rules as any other page.

## Frontmatter Access

Use `useFrontmatter()` in layout components to read the current page's frontmatter:

::: code-group

```tsx [React]
import { useFrontmatter } from "void/md";

export default function DocsLayout({ children }) {
  const fm = useFrontmatter();
  return (
    <div>
      <h1>{fm.title}</h1>
      {children}
    </div>
  );
}
```

```vue [Vue]
<script setup>
import { useFrontmatter } from "void/md";

const fm = useFrontmatter();
// fm.title, fm.description, etc.
</script>

<template>
  <h1>{{ fm.title }}</h1>
  <slot />
</template>
```

```svelte [Svelte]
<script>
import { useFrontmatter } from "void/md";

const fm = useFrontmatter();
</script>

<h1>{fm.title}</h1>
<slot />
```

```tsx [Solid]
import { useFrontmatter } from "void/md";

export default function DocsLayout(props) {
  const fm = useFrontmatter();
  return (
    <div>
      <h1>{fm.title}</h1>
      {props.children}
    </div>
  );
}
```

:::

## Pages Virtual Module

Import `void/md/pages` to get metadata for all markdown pages at build time. Use it to build sidebars, navigation, or search indexes:

```ts
import pages from "void/md/pages";
// [{ path: "/docs/getting-started", title: "Getting Started", frontmatter: {...}, headings: [...] }, ...]
```

Each entry has this shape:

```ts
interface MdPage {
  path: string; // route path
  title: string; // from frontmatter.title or first h1
  frontmatter: Record<string, unknown>; // full parsed frontmatter
  headings: { depth: number; slug: string; text: string }[]; // extracted headings
}
```

The array is sorted by path and updates on HMR in dev when `.md` files are added, removed, or changed.

## Default Theme

Import the default theme stylesheet to get prose typography, code highlighting, and container styles:

```css
@import "@void-x/md/theme";
```

Wrap your markdown content in a `.void-md` element to scope the styles:

```html
<main class="void-md">
  <slot />
</main>
```

The theme covers:

- **Prose** — headings, paragraphs, lists, blockquotes, tables, inline code, links, horizontal rules. Dark mode via `prefers-color-scheme`.
- **Code blocks** — Shiki dual-theme highlighting (light/dark), CSS-driven switching, zero JS.
- **Containers** — `:::tip`, `:::warning`, `:::danger`, `:::info`, `:::details` styles.
- **GitHub alerts** — `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, etc.

Users who want full control can skip the import and write their own CSS.

## Markdown Features

All features produce static HTML at build time with zero client JS (except the copy button).

### Containers

```md
::: tip
Helpful advice here.
:::

::: warning
Watch out for this.
:::

::: danger
This will break things.
:::

::: info
Some context.
:::

::: details Click to expand
Hidden content here.
:::
```

Custom titles work too: `::: tip Pro Tip`.

### GitHub Alerts

```md
> [!NOTE]
> Useful information.

> [!TIP]
> Helpful advice.

> [!IMPORTANT]
> Key information.

> [!WARNING]
> Potential issues.

> [!CAUTION]
> Dangerous actions.
```

### Syntax Highlighting

Code blocks are highlighted at build time via [Shiki](https://shiki.style) with dual light/dark themes (default: `github-light` / `github-dark`). No client-side JavaScript is needed — theme switching is pure CSS.

### Line Highlighting

Highlight specific lines with `{lines}` in the code fence meta:

````md
```ts {1,3-5}
const a = 1; // highlighted
const b = 2;
const c = 3; // highlighted
const d = 4; // highlighted
const e = 5; // highlighted
```
````

### Diff, Focus, and Error Levels

Use inline comments to annotate lines:

```ts
export function hello() {
  console.log("old"); // [!code --]
  console.log("new"); // [!code ++]
  console.log("look here"); // [!code focus]
  console.log("problem"); // [!code error]
  console.log("careful"); // [!code warning]
}
```

### Copy Button

Code blocks include a copy button (the only feature requiring client JS — a ~200 byte inline script for the clipboard API). It is injected only when code blocks are present.

### Line Numbers

Enable per code block with `:line-numbers` or disable with `:no-line-numbers`:

````md
```ts :line-numbers
const a = 1;
const b = 2;
```
````

Start from a specific number with `:line-numbers=5`.

### Snippet Imports

Import code from external files:

```md
<<< ./path/to/file.ts
```

### Emoji

Shortcodes convert to unicode: `:tada:` becomes :tada:, `:rocket:` becomes :rocket:.

### Attributes

Add classes, IDs, or attributes to any element:

```md
# Heading {.custom-class #my-id}

Paragraph with attributes. {.note}
```

### Heading Anchors

All headings get permalink anchors automatically, enabling direct linking to any section.

### Table of Contents

Use the `[[toc]]` directive to render an inline table of contents from the page's headings.

### Images

Image paths are normalized automatically. Images are lazy-loaded by default.

### Links

External links automatically get `target="_blank" rel="noreferrer"`. Internal `.md` references resolve to their route paths.

## Plugin Options

```ts
voidMarkdown({
  shiki: {
    themes: { light: "github-light", dark: "github-dark" }, // Shiki themes
    langs: ["sql", "graphql"], // additional languages
  },
});
```

| Option         | Type                             | Default                                          | Description                  |
| -------------- | -------------------------------- | ------------------------------------------------ | ---------------------------- |
| `shiki.themes` | `{ light: string; dark: string}` | `{ light: "github-light", dark: "github-dark" }` | Shiki color themes           |
| `shiki.langs`  | `string[]`                       | Common web languages                             | Additional languages to load |

## Example: Docs Layout with Sidebar

Here's a full example of a docs layout using `useFrontmatter()` and `void/md/pages` to build a sidebar:

::: code-group

```vue [Vue]
<!-- pages/docs/layout.island.vue -->
<script setup>
import { useFrontmatter } from "void/md";
import pages from "void/md/pages";
import { useRouter } from "void/vue";

const fm = useFrontmatter();
const { path } = useRouter();
const docPages = pages.filter((p) => p.path.startsWith("/docs/"));
</script>

<style>
@import "@void-x/md/theme";
</style>

<template>
  <div class="docs-layout">
    <aside>
      <nav>
        <a
          v-for="page in docPages"
          :key="page.path"
          :href="page.path"
          :class="{ active: page.path === path }"
        >
          {{ page.title }}
        </a>
      </nav>
    </aside>
    <main class="void-md">
      <h1>{{ fm.title }}</h1>
      <slot />
    </main>
  </div>
</template>
```

```tsx [React]
// pages/docs/layout.island.tsx
import { useFrontmatter } from "void/md";
import pages from "void/md/pages";
import { useRouter } from "void/react";

const docPages = pages.filter((p) => p.path.startsWith("/docs/"));

export default function DocsLayout({ children }) {
  const fm = useFrontmatter();
  const { path } = useRouter();

  return (
    <div className="docs-layout">
      <aside>
        <nav>
          {docPages.map((page) => (
            <a key={page.path} href={page.path} className={page.path === path ? "active" : ""}>
              {page.title}
            </a>
          ))}
        </nav>
      </aside>
      <main className="void-md">
        <h1>{fm.title}</h1>
        {children}
      </main>
    </div>
  );
}
```

:::
