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
- `"fullstack"` — worker + assets (API routes, SSR, jobs)
- `"framework"` — meta framework (TanStack Start, React Router)

### `outputDir`

Output directory for static deploys, relative to the project root. Only relevant when `mode` is `"spa"` or `"ssg"`. Defaults to `"dist"`.

### `wrangler`

Curated Cloudflare Workers configuration. Binding arrays (`d1_databases`, `kv_namespaces`, `r2_buckets`) are not allowed here — bindings are fully managed by vite-cloud via inference and the `bindings` field. Users wanting custom bindings should use a `wrangler.json` with real binding IDs and `wrangler deploy`.

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

## Environment Variables

Vite Cloud uses Vite's standard `.env` convention for environment variables.

### `.env` (committed)

Non-secret configuration. All variables are injected into the worker `env` object. Variables prefixed with `VITE_` are also available on `import.meta.env` in client code.

```
API_URL=https://api.example.com
VITE_APP_TITLE=My App
```

Access in route handlers via `c.env`:

```ts
export const GET = defineHandler((c) => {
  const apiUrl = c.env.API_URL;
  return { apiUrl };
});
```

### `.env.local` (gitignored)

Secrets for local development. This file should be added to `.gitignore` and never committed.

```
GITHUB_SECRET=your-github-client-secret
STRIPE_KEY=sk_test_...
```

To push local secrets to production, use [`vcd secret sync`](/cli#vcd-secret-sync).

### How it works

During `vite dev`, the `vite-cloud:env` plugin calls Vite's `loadEnv()` and merges all variables into the worker's `vars` bindings. During `vcd deploy`, `.env` variables (but not `.env.local`) are included in the deploy manifest as `plain_text` bindings on the deployed worker.

Secrets should never go in `.env` — use `.env.local` for local dev and `vcd secret put` or `vcd secret sync` for production.
