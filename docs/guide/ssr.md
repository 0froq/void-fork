---
outline: deep
---

# Custom SSR

Void supports framework-agnostic SSR via explicit server and client entries. This is for advanced use cases where you want full control over rendering and hydration.

::: tip
For most apps, [Pages Routing](./pages-routing/overview) handles SSR automatically. You do not need entry files or hydration code.
:::

## Relationship to Pages Routing

Custom SSR is separate from Pages Routing. Use Custom SSR when you want to bring
your own root component, router, data loading, HTML shell, and hydration logic.

The `App` component below is the root of this custom-rendered application:

```tsx
// src/App.tsx
export default function App({ url }: { url: string }) {
  return url === '/about' ? <main>About</main> : <main>Home</main>;
}
```

Pages Routing adapters generate their own SSR and hydration entries and compose
`pages/layout.*`, route components, loaders, and actions.

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
  css: string; // stylesheet links for <head>
  preloads: string; // modulepreload/Vite client+preamble tags for <head>
  body: string; // main client entry script tag before </body>
}
```

If no render export is found, build/deploy fails with a clear error.

Example:

```tsx
import { renderToString } from 'react-dom/server';
import { defineRender } from 'void';
import App from './App';

export default defineRender(async (c, assetTags) => {
  const url = new URL(c.req.raw.url);
  const html = renderToString(<App url={url.pathname} />);
  return new Response(
    `<!doctype html>
<html>
  <head>${assetTags.css}${assetTags.preloads}</head>
  <body>
    <div id="root">${html}</div>
    ${assetTags.body}
  </body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
});
```

`src/main.client.ts(x)` should hydrate/mount your app:

```tsx
import { hydrateRoot } from 'react-dom/client';
import App from './App';

hydrateRoot(document.getElementById('root')!, <App url={window.location.pathname} />);
```

## Caching

See [Revalidation](./edge/revalidation.md) for stale-while-revalidate caching of SSR pages.

API routes and static files are served before custom rendering. Unmatched non-API requests use `render(c, assetTags)`.
