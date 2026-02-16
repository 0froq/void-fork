# SSG (Prerender)

You can pre-render static HTML by exporting a `prerender` path list or function from `src/main.ssr.ts(x)`.

This requires [SSR](./ssr.md) to be configured — prerender uses your SSR render entry to generate HTML at build time.

## Static array

```ts
export const prerender = ["/", "/about", "/pricing"];
```

## Function

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

## Behavior

- runs during production build
- each path is rendered through your SSR entry and written to `dist/client`
- output shape is always `<path>/index.html` (for example `/about` -> `about/index.html`)
- `/about/` is normalized to `/about`
- prerender paths must be absolute and must not contain dynamic segments
- any prerender failure hard-fails the build

At runtime, these generated HTML files are served as static assets before SSR fallback.
