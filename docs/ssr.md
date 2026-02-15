# SSR

Vite Cloud supports framework-agnostic SSR via explicit server and client entries.

## Required entries

SSR mode is enabled when both of these exist:

- `src/main.ssr.ts` or `src/main.ssr.tsx`
- `src/main.client.ts` or `src/main.client.tsx`

Only one server entry and one client entry may exist.
If only one side is present, build/deploy fails with a clear error.

## Render API

`src/main.ssr.ts(x)` must export either:

```ts
render(c: CloudContext, assetTags: RenderAssetTags): Response | Promise<Response>
```

or:

```ts
export default defineRender((c, assetTags) => Response | Promise<Response>);
```

The recommended form is `defineRender(...)` for inferred types.

`assetTags` contains the HTML tags for your client assets:

```ts
{
  head: string; // styles/modulepreload/Vite client+preamble (dev)
  body: string; // main client entry script tag
}
```

If no render export is found, build/deploy fails with a clear error.

Example:

```tsx
import { renderToString } from "react-dom/server";
import { defineRender } from "vite-cloud";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const url = new URL(c.req.raw.url);
  const html = renderToString(<App url={url.pathname} />);
  return new Response(
    `<!doctype html>
<html>
  <head>${assetTags.head}</head>
  <body>
    <div id="root">${html}</div>
    ${assetTags.body}
  </body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
});
```

`src/main.client.ts(x)` should hydrate/mount your app:

```tsx
import { hydrateRoot } from "react-dom/client";
import App from "./App";

hydrateRoot(document.getElementById("root")!, <App url={window.location.pathname} />);
```

## Client Asset Injection

Vite Cloud no longer mutates your rendered HTML automatically.
You decide whether and where to inject client asset tags.

The `assetTags` values are computed by Vite Cloud:

- In production: from `dist/client/.vite/manifest.json` (entry script, CSS, modulepreload)
- In dev: includes Vite HMR client and React refresh preamble (when React plugin is active), plus the client entry script

## SSG (Prerender)

You can pre-render static HTML by exporting a `prerender` path list or function from `src/main.ssr.ts(x)`.

### Static array

```ts
export const prerender = ["/", "/about", "/pricing"];
```

### Function

For dynamic path lists (CMS content, markdown files, etc.), export a function:

```ts
// Arrow function
export const prerender = async () => {
  const posts = Object.keys(import.meta.glob("./content/blog/*.md")).map((file) => {
    return `/blog/${file.split("/").pop()!.replace(".md", "")}`;
  });
  return ["/", ...posts];
};
```

```ts
// Named function
export async function prerender() {
  const res = await fetch("https://cms.example.com/api/posts");
  const posts = await res.json();
  return ["/", ...posts.map((p) => `/blog/${p.slug}`)];
}
```

The function runs during production build (inside `closeBundle`), so network calls like `fetch()` are supported.
`src/main.ssr.ts(x)` is also bundled for the Cloudflare Worker runtime. Cloudflare Workers do not support Node built-ins like `node:fs`, so avoid `node:*` imports in this file (including inside `prerender`).

For file-driven prerender lists and content loading, prefer Vite module graph APIs:

- `import.meta.glob()` to discover matching files
- dynamic imports like `await import(\`./content/blog/${slug}.md?raw\`)` to load file contents

### Behavior

- runs during production build
- each path is rendered through your SSR entry and written to `dist/client`
- output shape is always `<path>/index.html` (for example `/about` -> `about/index.html`)
- `/about/` is normalized to `/about`
- prerender paths must be absolute and must not contain dynamic segments
- any prerender failure hard-fails the build

At runtime, these generated HTML files are served as static assets before SSR fallback.

## Request flow

With SSR enabled:

1. `/api/*` requests go to worker API routes
2. static asset hits are served from R2
3. unmatched non-API requests fall back to `render(c, assetTags)`

Without SSR entries, non-API requests keep SPA static fallback behavior.
