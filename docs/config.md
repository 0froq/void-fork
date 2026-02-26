---
outline: deep
---

# Configuration

## Config File Format

All project-level configuration lives in a `void.json` file at the project root. Every field is optional — missing file means all defaults.

```json
{
  "$schema": "./node_modules/void/schema.json",
  "auth": ["github", "google", "email"],
  "bindings": { "db": true, "kv": false },
  "cache": {
    "revalidate": { "/": 60, "*": 30 }
  },
  "headers": {
    "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
  },
  "mode": "spa",
  "outputDir": "dist",
  "wrangler": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```

Add the `$schema` field for autocomplete and validation in your editor.

## Fields

### `auth`

Enable built-in auth routes and session management.

- `true` — enables email-only auth.
- An array of providers (`"github"`, `"google"`, `"email"`) — enables specific providers.
- `false` or omitted — disables auth entirely.

```json
{ "auth": ["github", "email"] }
```

### `bindings`

Explicitly control inferred Cloudflare bindings. If omitted, bindings are [automatically inferred](./resource-inference.md) by scanning your source files for binding usage. If provided, explicit values take precedence and inference is skipped entirely.

Each binding accepts `true` (use default name), `false` (disable), or a string (custom binding name):

```json
{ "bindings": { "db": true, "kv": false, "storage": "MY_BUCKET" } }
```

| Key       | Default Binding | Type          | Custom Name              |
| --------- | --------------- | ------------- | ------------------------ |
| `db`      | `DB`            | `D1Database`  | `"db": "MY_DB"`          |
| `kv`      | `KV`            | `KVNamespace` | `"kv": "MY_KV"`          |
| `storage` | `STORAGE`       | `R2Bucket`    | `"storage": "MY_BUCKET"` |
| `ai`      | `AI`            | `Ai`          | Boolean only             |

Custom names are used in the deploy manifest and in wrangler binding sync for local dev.

### `build`

Override the build command. Useful for frameworks with their own CLIs (Nuxt, Astro) or custom build scripts. If omitted, the CLI uses the framework's default build command.

```json
{ "build": "nuxt build --preset cloudflare-module" }
```

### `scanDirs`

Override which directories are scanned for [binding inference](./resource-inference.md). Paths are relative to the project root. Replaces the default directories for the current mode.

```json
{ "scanDirs": ["src", "lib", "workers"] }
```

### `cache`

Caching configuration. See [Revalidation](./cache/revalidation.md) and [Custom Headers](./cache/headers.md) for details.

| Sub-field    | Type                               | Description                                         |
| ------------ | ---------------------------------- | --------------------------------------------------- |
| `revalidate` | `number \| Record<string, number>` | ISR revalidation TTL in seconds, global or per-path |
| `prerender`  | `string[]`                         | Paths to prerender as static HTML at deploy time    |

```json
{
  "cache": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "*": 30
    },
    "prerender": ["/", "/about", "/pricing"]
  }
}
```

Each path in `prerender` must start with `/`.

### `headers`

Custom response headers for static assets. Keys are URL patterns, values are arrays of `"Name: value"` strings. See [Custom Headers](./cache/headers.md) for details.

```json
{
  "headers": {
    "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
  }
}
```

### `mode`

Deployment mode. If omitted, auto-detected on first deploy. See [Supported App Types](./app-types.md).

- `"spa"` — static single-page app
- `"ssg"` — static site generation
- `"fullstack"` — worker + assets (API routes, SSR, jobs)
- `"framework"` — meta framework (TanStack Start, React Router, SvelteKit, Nuxt, Astro)

### `outputDir`

Output directory for static deploys, relative to the project root. Only relevant when `mode` is `"spa"` or `"ssg"`. Defaults to `"dist"`.

### `wrangler`

Curated Cloudflare Workers configuration. Binding arrays (`d1_databases`, `kv_namespaces`, `r2_buckets`) are not allowed here — bindings are fully managed by void via inference and the `bindings` field. Users wanting custom bindings should use a `wrangler.json` with real binding IDs and `wrangler deploy`.

| Field                 | Type       | Description                            |
| --------------------- | ---------- | -------------------------------------- |
| `compatibility_date`  | `string`   | Cloudflare Workers compatibility date  |
| `compatibility_flags` | `string[]` | Cloudflare Workers compatibility flags |

```json
{
  "wrangler": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"]
  }
}
```
