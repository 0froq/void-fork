# @vite-cloud/react

React framework adapter for Vite Cloud Pages mode — Inertia-inspired full-stack DX with SSR.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudReact } from "@vite-cloud/react/plugin";

export default defineConfig({
  plugins: [viteCloud(), viteCloudReact()],
});
```

## Plugin

`viteCloudReact(options?)` returns `[@vitejs/plugin-react, pagesPlugin]`.

Options:

- `react?` — options passed to `@vitejs/plugin-react`
- `viewTransitions?` — enable View Transitions API for SPA navigation

The pages plugin generates two virtual modules:

- `virtual:vite-cloud-pages-renderer` — SSR entry using `renderToString()` from `react-dom/server`
- `virtual:vite-cloud-pages-client` — client hydration entry using `hydrateRoot()` from `react-dom/client`

## Runtime

Import from `@vite-cloud/react`:

- **`Link`** — SPA navigation component. Renders `<a>` for GET, `<button>` otherwise. Intercepts clicks for client-side navigation.
- **`useForm(url, defaults, options?)`** — Form state management using `useState`. Methods: `post`, `put`, `patch`, `delete`, `reset`, `clearErrors`.
- **`useShared()`** — Access shared data from middleware (`c.set("shared", ...)`)
- **`useRouter()`** — Access the router for programmatic navigation

## Pages

Pages are `.tsx` files in the `pages/` directory with companion `.server.ts` files:

```tsx
// pages/index.tsx
export default function Home({ title }: { title: string }) {
  return <h1>{title}</h1>;
}
```

```ts
// pages/index.server.ts
import { defineHandler } from "vite-cloud";

export const loader = defineHandler(() => {
  return { title: "Home" };
});
```

## Architecture

- **Runtime is pre-built** — compiled with tsdown to ESM + DTS. The plugin entry (`./plugin`) is also pre-built.
- **React state for client** — `useSyncExternalStore` with module-level listener pattern drives page/props/shared/errors updates.
- **Context-based DI** — React `createContext`/`useContext` provides router, shared data, and errors to child components.

## Tests

- `test/unit/use-form.test.ts` — 14 tests for form core logic
- `test/integration/react-pages-playground.test.ts` — Server-side SSR + Inertia protocol tests
- `test/integration/react-pages-client.test.ts` — Playwright browser tests (dev + preview) for hydration, SPA navigation, forms
