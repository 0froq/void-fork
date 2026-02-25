---
outline: deep
---

# Custom Headers

Define custom response headers in [`void.json`](../config.md) using the `headers` field. Keys are URL patterns, values are arrays of `"Name: value"` strings.

```json
{
  "headers": {
    "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
    "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"],
    "/*.html": ["Cache-Control: no-cache"]
  }
}
```

## Rules

- **Pattern keys** start with `/`. `*` matches any characters including `/`.
- **Header values** use `Name: value` format. The value may contain colons.
- All matching rules are merged. When multiple rules set the same header name, the **last match wins**.
- User-defined `Cache-Control` overrides the built-in default. The default still applies when no rule matches.

## Example: security headers

```json
{
  "headers": {
    "/*": [
      "X-Frame-Options: DENY",
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: strict-origin-when-cross-origin"
    ]
  }
}
```

## Example: override caching

```json
{
  "headers": {
    "/*.html": ["Cache-Control: public, max-age=300"],
    "/config.json": ["Cache-Control: no-store"]
  }
}
```

## Scope

Header rules apply to **static asset responses only** — files served from R2 (including SPA `index.html` fallbacks and SSG pages). They do not apply to:

- API route responses (`/api/*` dispatched to your worker)
- SSR-rendered responses (when a static asset is not found and the request falls through to your worker)

## How headers work

1. `void deploy` reads header rules from `void.json` and includes them in the deploy manifest.
2. The platform stores the rules in the KV routing entry for your project.
3. The dispatch worker applies matching rules to static responses before edge caching.

Because rules are evaluated at the edge, there is no latency cost — headers are applied inline before the response is returned and cached.
