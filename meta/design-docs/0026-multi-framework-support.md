# Multi-Framework Support

**Date:** 2026-02-25
**Status:** Draft

---

## Summary

Extend `void deploy` to support any Vite-based meta-framework that can produce a Cloudflare Workers-compatible bundle. Three framework classes, each with a different integration depth:

- **Class A** — Frameworks that ship as a Vite plugin and deploy via CF's Vite plugin (TanStack Start, React Router). Already implemented.
- **Class B** — Frameworks that ship as a Vite plugin but use their own CF adapter (SvelteKit). Include `voidPlugin()` for DX features.
- **Class C** — Frameworks with their own CLIs and adapters (Nuxt, Astro). `void deploy` is a deploy tool only.

---

## Framework Classification

Detection via `package.json` dependencies:

```typescript
type FrameworkClass = "a" | "b" | "c";

interface DetectedFramework {
  name: string;
  class: FrameworkClass;
}

const FRAMEWORK_PACKAGES: Record<string, DetectedFramework> = {
  "@tanstack/react-start": { name: "tanstack-start", class: "a" },
  "@react-router/dev": { name: "react-router", class: "a" },
  "@sveltejs/kit": { name: "sveltekit", class: "b" },
  nuxt: { name: "nuxt", class: "c" },
  astro: { name: "astro", class: "c" },
};
```

---

## Feature Matrix

| Feature                   | Class A      | Class B       | Class C            | Class C + voidPlugin() |
| ------------------------- | ------------ | ------------- | ------------------ | ---------------------- |
| Binding inference         | Yes          | Yes           | No (void.json)     | No (void.json)         |
| `void/db`, `void/kv` etc. | Yes          | Yes           | Yes (add void dep) | Yes (add void dep)     |
| DB type codegen           | Yes (auto)   | Yes (auto)    | No                 | Yes (auto)             |
| Migrations (dev)          | Yes (auto)   | Yes (auto)    | No                 | Yes (auto)             |
| Migrations (deploy)       | Yes          | Yes           | Yes                | Yes                    |
| Auth                      | Yes          | Yes (wrapper) | Yes (wrapper)      | Yes (wrapper)          |
| Queues / Crons            | Yes          | Yes (wrapper) | Yes (wrapper)      | Yes (wrapper)          |
| ISR / Revalidate          | Yes (config) | Yes (config)  | Yes (config)       | Yes (config)           |
| Prerender                 | Yes (config) | Yes (config)  | Yes (config)       | Yes (config)           |

Notes:

- Per-page `export const revalidate` / `prerender` auto-discovery is a void Pages mode feature, not available in any framework class. All framework classes use `void.json` `cache.revalidate` and `cache.prerender` config.
- Class C can optionally add `voidPlugin()` to their framework's Vite config for auto DB type codegen and dev-time migration management. Both Nuxt and Astro support Vite plugins in their config.

---

## Framework Presets

Each framework has a preset defining its build output conventions:

```typescript
interface FrameworkPreset {
  buildCommand: string;
  workerDir: string;
  workerMain: string;
  assetsDir: string;
}

const FRAMEWORK_PRESETS: Record<string, FrameworkPreset> = {
  sveltekit: {
    buildCommand: "vite build",
    workerDir: ".svelte-kit/cloudflare",
    workerMain: "_worker.js",
    assetsDir: ".svelte-kit/cloudflare",
  },
  nuxt: {
    buildCommand: "nuxt build",
    workerDir: ".output/server",
    workerMain: "index.mjs",
    assetsDir: ".output/public",
  },
  astro: {
    buildCommand: "astro build",
    workerDir: "dist/_worker.js",
    workerMain: "index.js",
    assetsDir: "dist",
  },
};
```

When `workerDir` is inside `assetsDir` (SvelteKit, Astro), worker files are excluded from asset collection.

---

## Wrangler Config Parsing

After the framework build, read `wrangler.json(c)` from the project root. Extract only:

- `compatibility_date`
- `compatibility_flags`

Output paths come from presets, not from the wrangler config.

---

## void.json Extensions

### Bindings (custom names)

Extend `bindings` to accept a string for custom binding names (for Class C):

```typescript
bindings?: {
  db?: boolean | string;      // true → "DB", string for custom name
  kv?: boolean | string;      // true → "KV"
  storage?: boolean | string; // true → "STORAGE"
  ai?: boolean;
}
```

Single instance per binding type. Multi-binding support deferred to a separate design.

### Build command override

```typescript
build?: string;   // overrides the preset's buildCommand
```

### Prerender paths

```typescript
cache?: {
  revalidate?: number | Record<string, number>;  // existing
  prerender?: string[];                           // new — explicit paths to prerender at deploy
}
```

### Auth

```typescript
auth?: boolean | AuthProvider[];  // already exists, used by Class C for explicit auth config
```

---

## DeployManifest Extensions

New optional fields on v1 (backward compatible, no version bump):

```typescript
interface DeployManifest {
  // ... existing fields ...
  workerMain?: string; // entry module filename (default: "index.js")
  compatibilityDate?: string; // from framework's wrangler config
  compatibilityFlags?: string[]; // from framework's wrangler config
}
```

---

## API Changes

In `packages/api/src/routes/deploy.ts`, the worker upload metadata uses the new manifest fields with fallbacks:

```typescript
const metadata = {
  main_module: manifest.workerMain ?? "index.js",
  compatibility_date: manifest.compatibilityDate ?? "2026-02-12",
  compatibility_flags: manifest.compatibilityFlags ?? ["nodejs_compat"],
  bindings: /* unchanged */,
  triggers: /* unchanged */,
};
```

---

## The Wrapper

For Class B and C, void features that hook into the worker (auth, queues, crons) are implemented via a **wrapper entry module** that wraps the framework's original worker.

Generated when **any** of auth, queues, or crons are present. Bundled with Vite as a post-build step.

```javascript
// generated void-wrapper.js (conceptual)
import original from "./index.mjs";
import { authContext, resolveSession, handleAuth } from "./void-auth.js";
import { handleScheduled } from "./void-scheduled.js";
import { handleQueue } from "./void-queue.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__auth/")) return handleAuth(request, env, ctx);

    const user = await resolveSession(request, env);
    return authContext.run({ user }, () => original.fetch(request, env, ctx));
  },
  scheduled: handleScheduled,
  queue: handleQueue,
};
```

- If no auth: fetch is a direct passthrough to `original.fetch`
- If no crons: no `scheduled` export
- If no queues: no `queue` export
- If none of the above: no wrapper generated, framework's entry used directly

The wrapper source is generated at deploy time and bundled with Vite (targeting `webworker`, ESM output). The framework's built worker is treated as a pre-built dependency. The `workerMain` in the manifest points to the wrapper instead of the framework's original entry.

### Auth via ALS

The wrapper validates the session cookie and runs the framework's fetch inside an `AsyncLocalStorage` context. `void/auth` runtime reads the current user from this context — framework-agnostic.

For Class C, users add `void` as a dependency to access `void/auth`.

### Queue/Cron Handlers

`crons/` and `queues/` directories are scanned the same way as Class A. Handler files are compiled as part of the wrapper Vite bundle.

---

## voidPlugin() for Class B and C

When a Class B or C framework is detected, `voidPlugin()` runs in a lighter mode:

```
Class A:
  voidPlugin() → [dbTypesPlugin, migrationPlugin, ...cloudflare({ viteEnvironment, config })]

Class B:
  voidPlugin() → [dbTypesPlugin, migrationPlugin]

Class C (optional — added to framework's Vite config):
  voidPlugin() → [dbTypesPlugin, migrationPlugin]
```

Class B and C get the same plugin composition. Both Nuxt and Astro support Vite plugins in their config:

```typescript
// nuxt.config.ts
import { voidPlugin } from "void";
export default defineNuxtConfig({
  vite: { plugins: [voidPlugin()] },
});

// astro.config.mjs
import { voidPlugin } from "void";
export default defineConfig({
  vite: { plugins: [voidPlugin()] },
});
```

### What's included

- **DB type codegen** — generates `.void/db.d.ts` from schema
- **Migration plugin** — watches `migrations/`, auto-applies in dev
- **Binding inference** (Class B only) — scans `.ts` server files in `FRAMEWORK_SCAN_DIRS`
- **Wrangler.jsonc binding sync** — keeps local dev bindings in sync (see below)

### What's excluded

- **`cloudflare()` Vite plugin** — framework's adapter handles the CF worker build
- **Routing plugin** — framework owns routing
- **Entry generation** — framework controls worker entry

### Wrangler.jsonc binding sync

All three framework adapters use `getPlatformProxy()` from the `wrangler` package for local dev binding emulation, which reads binding declarations from `wrangler.jsonc`. `voidPlugin()` syncs bindings to `wrangler.jsonc` on dev startup so local dev Just Works:

| Class                  | Binding source       | Sync to wrangler.jsonc  |
| ---------------------- | -------------------- | ----------------------- |
| Class B (SvelteKit)    | Inferred from source | Yes (auto)              |
| Class C + voidPlugin() | `void.json`          | Yes (auto)              |
| Class C (no plugin)    | N/A                  | User maintains manually |

---

## Deploy Flow

### Class A (existing, no changes)

1. `vite build` (CF plugin produces worker)
2. Infer bindings
3. Inject Vite manifest into worker entry
4. Package manifest + worker + assets + migrations
5. Upload

### Class B (SvelteKit)

1. Detect framework from `package.json`
2. `vite build` (SvelteKit adapter produces worker)
3. Infer bindings from source
4. Scan `crons/` and `queues/`, read auth config
5. If wrapper needed: generate wrapper entry, bundle with Vite
6. Read `wrangler.jsonc` for compat settings
7. Use preset for output paths
8. Collect migrations
9. Package manifest + worker + assets + migrations
10. Upload

### Class C (Nuxt, Astro)

1. Detect framework from `package.json`
2. Run framework build command (e.g. `nuxt build`)
3. Read bindings and auth from `void.json`
4. Scan `crons/` and `queues/`
5. Collect migrations from `migrations/` if present
6. If wrapper needed: generate wrapper entry, bundle with Vite
7. Read `wrangler.jsonc` for compat settings
8. Use preset for output paths
9. Package manifest + worker + assets + migrations
10. Upload

---

## What Changes Where

| File                                | Change                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `framework/.../plugin-inference.ts` | Extend `detectFramework()` with class info; add Class B/C framework entries  |
| `framework/.../index.ts`            | Class B plugin composition (no CF plugin, write wrangler.jsonc bindings)     |
| `framework/.../cli/deploy.ts`       | Class B/C deploy paths — preset lookup, wrangler parsing, wrapper bundling   |
| `framework/.../cli/package.ts`      | Support `workerMain`, `compatibilityDate`, `compatibilityFlags` in manifest  |
| `framework/.../cli/preset.ts`       | Add `FRAMEWORK_PRESETS` for SvelteKit, Nuxt, Astro                           |
| `framework/.../cli/wrangler.ts`     | New — parse wrangler.json/jsonc for compat settings                          |
| `framework/.../cli/wrapper.ts`      | New — generate + Vite-bundle the wrapper entry with auth/cron/queue handlers |
| `framework/.../config.ts`           | Extend `bindings` to accept `string`; add `build` and `cache.prerender`      |
| `packages/api/src/types.ts`         | Add optional `workerMain`, `compatibilityDate`, `compatibilityFlags`         |
| `packages/api/src/routes/deploy.ts` | Use new manifest fields in worker upload metadata                            |

---

## Binding Inference Notes

Current inference scans `**/*.{ts,tsx,mts,js,jsx,mjs}` — no `.vue` or `.svelte` files.

- **Class A**: Works today. Server code in `.ts` route files under `FRAMEWORK_SCAN_DIRS`.
- **Class B (SvelteKit)**: Works. Server code lives in `+page.server.ts`, `hooks.server.ts` etc. — all `.ts` files under `src/routes/`, covered by `FRAMEWORK_SCAN_DIRS`.
- **Class C**: No inference. Bindings from `void.json`.

Pre-existing gap (void default mode, not framework classes): `pages/` directory and `.vue` SFC `<script server>` blocks are not scanned. Separate fix, not part of this design.
