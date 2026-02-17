---
outline: deep
---

# Configuration

## Config File Format

All project-level configuration lives in a `vite-cloud.json` file at the project root. Every field is optional — missing file means all defaults.

```json
{
  "$schema": "https://unpkg.com/vite-cloud/schema.json",
  "auth": ["github", "google", "email"],
  "bindings": { "db": true, "kv": false },
  "headers": {
    "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
  },
  "mode": "spa",
  "outputDir": "dist",
  "wrangler": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"],
    "vars": { "MY_VAR": "value" }
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

Explicitly control inferred Cloudflare bindings. If omitted, bindings are inferred by scanning `routes/` and `middleware/` usage (`c.env.DB`, `c.env.KV`, `c.env.STORAGE`). If provided, explicit values take precedence over inference.

```json
{ "bindings": { "db": true, "kv": false, "storage": false } }
```

| Key       | Binding   | Type          |
| --------- | --------- | ------------- |
| `db`      | `DB`      | `D1Database`  |
| `kv`      | `KV`      | `KVNamespace` |
| `storage` | `STORAGE` | `R2Bucket`    |

### `headers`

Custom response headers for static assets. Keys are URL patterns, values are arrays of `"Name: value"` strings. See [Caching and Headers](./cache.md) for details.

```json
{
  "headers": {
    "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
  }
}
```

### `mode`

Deployment mode. If omitted, auto-detected on first deploy. See [App Types](./app-types.md).

- `"spa"` — static single-page app
- `"ssg"` — static site generation
- `"full"` — worker + assets (API routes, SSR, jobs)

### `outputDir`

Output directory for static deploys, relative to the project root. Only relevant when `mode` is `"spa"` or `"ssg"`. Defaults to `"dist"`.

### `wrangler`

Curated Cloudflare Workers configuration. Binding arrays (`d1_databases`, `kv_namespaces`, `r2_buckets`) are not allowed here — bindings are fully managed by vite-cloud via inference and the `bindings` field. Users wanting custom bindings should use a `wrangler.json` with real binding IDs and `wrangler deploy`.

| Field                 | Type                     | Description                            |
| --------------------- | ------------------------ | -------------------------------------- |
| `compatibility_date`  | `string`                 | Cloudflare Workers compatibility date  |
| `compatibility_flags` | `string[]`               | Cloudflare Workers compatibility flags |
| `vars`                | `Record<string, string>` | Environment variables (plain text)     |

```json
{
  "wrangler": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"],
    "vars": { "API_URL": "https://api.example.com" }
  }
}
```
