# @vite-cloud/vue

Vue framework adapter for Vite Cloud Pages mode. Provides Inertia-inspired full-stack DX: server-driven routing with SPA navigation, automatic prop passing, form helpers, and full SSR.

## Package Exports

| Export                   | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `@vite-cloud/vue`        | Runtime — `Link`, `useForm`, `useShared` composables |
| `@vite-cloud/vue/plugin` | Vite plugin factory — `viteCloudVue()`               |

## Vite Plugins

`viteCloudVue()` returns three plugins that must run in order:

1. **`scriptServerPlugin`** (`enforce: "pre"`) — Extracts `<script server>` blocks from `.vue` SFCs before `@vitejs/plugin-vue` compiles them. Stores the extracted code and serves it as a virtual module when imported via `?server` query.
2. **`@vitejs/plugin-vue`** — Standard Vue SFC compilation (the remaining template + `<script setup>`).
3. **`pagesPlugin`** — Generates two virtual modules:
   - `virtual:vite-cloud-pages-renderer` — SSR rendering function. Creates a Vue SSR app, resolves the layout chain, renders to HTML with embedded `data-page` attribute.
   - `virtual:vite-cloud-pages-client` — Client hydration entry. Mounts the SSR app, sets up the client-side router for SPA navigation, handles `popstate` for back/forward.

## Runtime Exports

- **`Link`** — Vue component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `preserveScroll`. Calls `router.visit()` on click.
- **`useForm(defaults)`** — Reactive form helper. Returns `{ data, errors, isDirty, processing, wasSuccessful, recentlySuccessful, reset(), clearErrors(), post(), put(), patch(), delete() }`. Submission calls `router.visit()` with the form data and bridges validation errors from the page response.
- **`useShared<T>()`** — Access middleware-set shared data (from `c.set("shared", ...)`). Returns a reactive object.

All composables use Vue's `provide`/`inject` internally. The SSR renderer provides `__vc_shared`, `__vc_errors`, and `__vc_router` (as `null` during SSR). The client entry provides the live reactive objects and the real router.

## Page Protocol

| Request type      | Detection                           | Response                                                                              |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| Initial page load | No `X-Inertia` header               | Full SSR HTML with embedded page object. Client hydrates.                             |
| SPA navigation    | `X-Inertia: true` header            | JSON page object `{ component, props, shared, url, errors }`. Client swaps component. |
| Form submission   | `X-Inertia: true` + POST/PUT/DELETE | Re-run loader (fresh props) or redirect.                                              |

## Server Handlers

Pages use Remix-style exports: `loader` (GET → props) and `action` (all mutations). Defined in `<script server>` blocks (Vue only) or companion `.server.ts` files (all frameworks).

```vue
<script server lang="ts">
import { defineHandler } from "vite-cloud";

export const loader = defineHandler(async (c) => {
  return { users: await db.list("users") };
});

export const action = defineHandler(async (c) => {
  await db.insert("users", await c.req.json());
});
</script>
```

- `loader` returns are passed as page props
- `action` void return → re-runs `loader` with fresh props
- `action` with `c.redirect()` → navigates to another page
- `ValidationError` → re-runs `loader`, attaches `errors` to page object

## Client Router

The generated client entry exposes a `router` object via `provide("__vc_router")`:

- `router.visit(url, options?)` — Core navigation. Sets `X-Inertia: true` header, resolves component + layouts atomically, updates reactive state.
- `router.post(url, data)`, `.put()`, `.patch()`, `.delete()` — Convenience wrappers around `visit()` with the HTTP method set.
- `router.reload()` — Re-fetches current page props without navigation.

## Architecture Notes

### Atomic Ref Updates

`updatePage()` resolves the component and layouts via `Promise.all` before setting any Vue refs. Props are set before the component ref — if the component changes, the first render already sees the new props.

### SSR `provide`/`inject` Completeness

During SSR, the app must `provide()` all keys that components may `inject()`, even if the value is `null`. Missing injections cause Vue warnings during SSR.

### `notFound` vs `get("*")`

Page catch-all routes use `app.notFound()` instead of `app.get("*")`. The latter intercepts Vite's module pipeline requests during dev, breaking HMR.

## Source Layout

```
src/
  index.ts                 # Plugin factory — viteCloudVue()
  plugin-script-server.ts  # Extracts <script server> blocks
  plugin-pages.ts          # Generates SSR renderer + client entry virtual modules
  pages-manifest.ts        # Generates component import map + layout tree
  runtime/
    index.ts               # Re-exports Link, useForm, useShared
    link.ts                # Link component
    use-form.ts            # useForm composable
    use-shared.ts          # useShared composable
```

## Tests

- `test/unit/script-server.test.ts` — `<script server>` extraction, `?server` resolution, lang attribute handling
- `test/integration/vue-pages-playground.test.ts` — SSR rendering, Inertia JSON protocol, form submission, validation errors, API coexistence
- `test/integration/vue-pages-client.test.ts` — Playwright-based client tests: hydration, SPA navigation, back/forward, form validation, form submission (runs against both dev and preview)
