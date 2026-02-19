---
outline: deep
---

# Environment Variables

Vite Cloud uses Vite's standard `.env` convention for environment variables.

## `.env` (committed)

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

## `.env.local` (gitignored)

Secrets for local development. This file should be added to `.gitignore` and never committed.

```
GITHUB_SECRET=your-github-client-secret
STRIPE_KEY=sk_test_...
```

To push local secrets to production, use [`vcd secret sync`](./cli#vcd-secret-sync).

## How it works

During `vite dev`, the `vite-cloud:env` plugin calls Vite's `loadEnv()` and merges all variables into the worker's `vars` bindings. During `vcd deploy`, `.env` variables (but not `.env.local`) are included in the deploy manifest as `plain_text` bindings on the deployed worker.

Secrets should never go in `.env` — use `.env.local` for local dev and `vcd secret put` or `vcd secret sync` for production.
