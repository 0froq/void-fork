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

# View Transitions

Pages mode supports the browser's native [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) for animated page transitions. When enabled, navigations are wrapped in `document.startViewTransition()`, giving you a smooth cross-fade between pages by default — customizable entirely via CSS.

## Enabling View Transitions

Pass `viewTransitions: true` to the adapter plugin:

::: code-group

```ts [React]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidReact({ viewTransitions: true })],
});
```

```ts [Vue]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidVue({ viewTransitions: true })],
});
```

```ts [Svelte]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidSvelte({ viewTransitions: true })],
});
```

```ts [Solid]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidSolid({ viewTransitions: true })],
});
```

:::

This enables view transitions for all navigations — `Link` clicks, programmatic `router.visit()` calls, and browser back/forward.

## Per-Link Override

Override the global setting on individual links:

::: code-group

```tsx [React]
{
  /* Disable transition for this link */
}
<Link href="/settings" viewTransition={false}>
  Settings
</Link>;

{
  /* Enable for just this link (even if globally disabled) */
}
<Link href="/about" viewTransition>
  About
</Link>;
```

```vue [Vue]
<!-- Disable transition for this link -->
<Link href="/settings" :view-transition="false">Settings</Link>

<!-- Enable for just this link (even if globally disabled) -->
<Link href="/about" view-transition>About</Link>
```

```svelte [Svelte]
<!-- Disable transition for this link -->
<Link href="/settings" viewTransition={false}>Settings</Link>

<!-- Enable for just this link (even if globally disabled) -->
<Link href="/about" viewTransition>About</Link>
```

```tsx [Solid]
{
  /* Disable transition for this link */
}
<Link href="/settings" viewTransition={false}>
  Settings
</Link>;

{
  /* Enable for just this link (even if globally disabled) */
}
<Link href="/about" viewTransition>
  About
</Link>;
```

:::

Or programmatically:

```ts
router.visit("/about", { viewTransition: true });
router.visit("/settings", { viewTransition: false });
```

## Customizing with CSS

The default transition is a cross-fade. Customize it using the `::view-transition-old` and `::view-transition-new` pseudo-elements:

```css
/* Faster transition */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 0.2s;
}

/* Slide instead of fade */
::view-transition-old(root) {
  animation: slide-out 0.3s ease-in;
}
::view-transition-new(root) {
  animation: slide-in 0.3s ease-out;
}
```

Assign `view-transition-name` to elements that should animate independently (e.g., a hero image that morphs between pages):

```css
.hero-image {
  view-transition-name: hero;
}
```

::: tip
View transitions are progressive enhancement — browsers that don't support the API fall back to instant navigation with no errors.
:::
