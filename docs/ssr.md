# SSR

Vite Cloud supports framework-agnostic SSR via explicit server and client entries.

## Required entries

SSR mode is enabled when both of these exist:

- `src/main.ssr.ts` or `src/main.ssr.tsx`
- `src/main.client.ts` or `src/main.client.tsx`

Only one server entry and one client entry may exist.
If only one side is present, build/deploy fails with a clear error.

## Render API

`src/main.ssr.ts(x)` must export:

```ts
render(request: Request, env: CloudEnv["Bindings"]): Response | Promise<Response>
```

If `render` is missing, build/deploy fails with a clear error.

Example:

```tsx
import { renderToString } from "react-dom/server";
import App from "./App";

export async function render(request: Request, env: { KV: KVNamespace }) {
  const url = new URL(request.url);
  const html = renderToString(<App url={url.pathname} />);
  return new Response(
    `<!doctype html><html><body><div id="root">${html}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
```

`src/main.client.ts(x)` should hydrate/mount your app:

```tsx
import { hydrateRoot } from "react-dom/client";
import App from "./App";

hydrateRoot(document.getElementById("root")!, <App url={window.location.pathname} />);
```

## Client Asset Injection

You do not manually add script/link tags in SSR HTML.

Vite Cloud injects client assets automatically:

- In production: reads `dist/client/.vite/manifest.json` and injects entry script, CSS, and modulepreload links.
- In dev: injects a module script for `/src/main.client.ts(x)`.

## Request flow

With SSR enabled:

1. `/api/*` requests go to worker API routes
2. static asset hits are served from R2
3. unmatched non-API requests fall back to `render(request, env)`

Without SSR entries, non-API requests keep SPA static fallback behavior.
