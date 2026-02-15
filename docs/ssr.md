# SSR

Vite Cloud supports framework-agnostic SSR via a minimal entry convention.

## Entry file

Create `src/ssr.entry.ts` (or `src/ssr.entry.tsx`):

```ts
import { renderToReadableStream } from "react-dom/server";
import App from "./App";

export async function render(request: Request, env: { KV: KVNamespace }) {
  const url = new URL(request.url);
  const stream = await renderToReadableStream(<App url={url.pathname} />);
  return new Response(stream, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
```

If this file exists, SSR mode is enabled automatically.
Only one SSR entry file should exist.

## Render API

Required export:

```ts
render(request: Request, env: CloudEnv["Bindings"]): Response | Promise<Response>
```

If the SSR entry exists but does not export `render`, build/deploy fails with a clear error.

## Request flow

With SSR enabled:

1. `/api/*` requests go to worker API routes
2. static asset hits are served from R2
3. unmatched non-API requests fall back to `render(request, env)`

Without SSR entry, non-API requests keep SPA static fallback behavior.
