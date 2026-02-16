# Caching and Headers

Vite Cloud serves static assets through Cloudflare's global edge network with sensible cache defaults. You can customize response headers for any path using a `_headers` file.

## Default caching behavior

Every deploy generates a new version identifier. Static asset responses are cached at the edge using versioned cache keys, so new deploys instantly invalidate stale entries without purge APIs.

### Hashed assets

Files in `assets/` (produced by Vite's build with content hashes in the filename, e.g. `assets/app-Ab3xK9.js`) are immutable — the filename changes whenever the content changes. These get aggressive caching:

```
Cache-Control: public, max-age=31536000, immutable
```

Cached at the edge for up to one year. Browsers cache them indefinitely.

### Non-hashed assets

Everything else (`index.html`, `favicon.ico`, etc.) uses short edge caching with browser revalidation:

```
Cache-Control: public, s-maxage=60, max-age=0, must-revalidate
```

Cached at the edge for 60 seconds. Browsers always revalidate on the next request. Combined with versioned cache keys, this means new deploys are visible within seconds.

### ETags and 304 Not Modified

All static asset responses include an `ETag` header derived from the file's content hash in R2. When a browser revalidates a cached resource, it sends `If-None-Match` with the previous ETag. If the file hasn't changed, the edge returns a **304 Not Modified** with no body — saving bandwidth and speeding up page loads.

This happens automatically for all static assets. No configuration is needed.

### API routes

API responses (`/api/*`) and SSR-rendered pages that fall through to the worker are **not** edge-cached by the dispatch layer.

## Custom headers with `_headers`

Place a `_headers` file in your `public/` directory (or your static output directory for `--dir` deploys). Vite copies `public/` files into the build output, and `vcd deploy` reads and applies the rules at the edge.

### Format

The format follows the [Netlify `_headers` convention](https://docs.netlify.com/routing/headers/):

```
# Pattern line (not indented, starts with /)
/assets/*
  Cache-Control: public, max-age=31536000, immutable

# Multiple headers under one pattern
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff

# HTML files
/*.html
  Cache-Control: no-cache
```

Rules:

- **Pattern lines** start with `/` and are not indented. `*` matches any characters including `/`.
- **Header lines** are indented (spaces or tabs) and use `Name: value` format. The value may contain colons.
- `#` comments and blank lines are ignored.
- All matching rules are merged. When multiple rules set the same header name, the **last match wins**.
- User-defined `Cache-Control` overrides the built-in default. The default still applies when no rule matches.

### Example: security headers

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
```

### Example: override caching

```
# Short cache for HTML pages
/*.html
  Cache-Control: public, max-age=300

# No caching for a specific path
/config.json
  Cache-Control: no-store
```

### Scope

Header rules apply to **static asset responses only** — files served from R2 (including SPA `index.html` fallbacks and SSG pages). They do not apply to:

- API route responses (`/api/*` dispatched to your worker)
- SSR-rendered responses (when a static asset is not found and the request falls through to your worker)

The `_headers` file itself is not served as a static asset.

## How it works

```
public/_headers → vite build → dist/client/_headers → vcd deploy → edge routing → applied to responses
```

1. Vite copies `_headers` from `public/` to the build output.
2. `vcd deploy` parses the file and includes the rules in the deploy manifest.
3. The platform stores the rules in the KV routing entry for your project.
4. The dispatch worker applies matching rules to static responses before edge caching.

Because rules are evaluated at the edge, there is no latency cost — headers are applied inline before the response is returned and cached.
