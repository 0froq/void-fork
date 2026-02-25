---
outline: deep
---

# Meta-Frameworks

Void supports deploying meta-framework apps to Cloudflare Workers via `void deploy`. The level of integration depends on how each framework builds and runs on Cloudflare.

## Supported Frameworks

| Framework                                           | Package                 | Integration                                                                  |
| --------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| [TanStack Start](https://tanstack.com/start/latest) | `@tanstack/react-start` | Vite plugin composition — `voidPlugin()` runs alongside the framework plugin |
| [React Router v7](https://reactrouter.com/)         | `@react-router/dev`     | Vite plugin composition — same as TanStack Start                             |
| [SvelteKit](https://svelte.dev/docs/kit)            | `@sveltejs/kit`         | Vite-based, uses its own Cloudflare adapter                                  |
| [Nuxt](https://nuxt.com/)                           | `nuxt`                  | Own CLI and build toolchain                                                  |
| [Astro](https://astro.build/)                       | `astro`                 | Own CLI and Cloudflare adapter                                               |

Detection is automatic — the CLI reads your `package.json` dependencies.

## How Each Framework Integrates

### TanStack Start & React Router

These frameworks use `@cloudflare/vite-plugin` under the hood. `voidPlugin()` runs alongside the framework plugin in the same Vite pipeline, providing binding inference, typed DB, migrations, and deployment.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { tanstackStart } from "@tanstack/react-start/plugin";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [voidPlugin(), tanstackStart(), react()],
});
```

All Void dev features work: binding inference, typed DB generation, migration runner, and hot reloading. See [App Types — Meta Frameworks](../app-types.md#meta-frameworks) for details.

### SvelteKit

SvelteKit uses Vite internally but has its own Cloudflare adapter (`@sveltejs/adapter-cloudflare`). `voidPlugin()` returns a slim plugin set — just wrangler binding sync, DB types, and migrations. The framework handles the build.

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { voidPlugin } from "void";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [voidPlugin(), sveltekit()],
});
```

During `pnpm dev`, `voidPlugin()` syncs inferred bindings into your `wrangler.jsonc` so the framework's `getPlatformProxy()` picks them up. During `void deploy`, the CLI runs `vite build`, locates the framework's output, and packages it for deployment.

### Nuxt & Astro

Nuxt and Astro have their own CLIs and build systems. Both expose a `vite` config option where you can add `voidPlugin()` to get the same dev features as SvelteKit — binding inference, DB types, migrations, and wrangler sync.

```ts
// nuxt.config.ts
import { voidPlugin } from "void";

export default defineNuxtConfig({
  nitro: { preset: "cloudflare-module" },
  vite: { plugins: [voidPlugin()] },
});
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { voidPlugin } from "void";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  vite: { plugins: [voidPlugin()] },
});
```

During `void deploy`, the CLI detects the framework, runs the appropriate build command, and packages the output.

## Feature Support

With `voidPlugin()` added to the framework's Vite config:

| Feature                    | TanStack / React Router | SvelteKit / Nuxt / Astro |
| -------------------------- | ----------------------- | ------------------------ |
| `void deploy`              | Yes                     | Yes                      |
| Binding inference (dev)    | Yes                     | Yes                      |
| Typed DB generation        | Yes                     | Yes                      |
| Migration runner (dev)     | Yes                     | Yes                      |
| Wrangler binding sync      | —                       | Yes                      |
| Auth wrapper               | Yes                     | Yes                      |
| Cron jobs                  | Yes                     | Yes                      |
| Queue consumers            | Yes                     | Yes                      |
| `void/db`, `void/kv`, etc. | Yes                     | No                       |
| File-based routing         | Yes                     | No                       |

SvelteKit, Nuxt, and Astro access Cloudflare bindings through their own mechanisms (e.g. `platform.env` in SvelteKit, `hubDatabase()` in Nuxt) or via `cloudflare:workers`.

## Configuration

### `void.json`

Projects using SvelteKit, Nuxt, or Astro use `void.json` for explicit binding and build configuration:

```json
{
  "$schema": "https://unpkg.com/void/schema.json",
  "bindings": { "db": true, "kv": true },
  "build": "nuxt build",
  "cache": {
    "prerender": ["/", "/about", "/pricing"]
  }
}
```

| Field             | Purpose                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `bindings`        | Explicitly enable bindings. Accepts `true` or a custom binding name (e.g. `"db": "MY_DB"`) |
| `build`           | Override the default build command                                                         |
| `cache.prerender` | Paths to prerender as static HTML at deploy time                                           |

See [Configuration](../config.md) for the full reference.

### `wrangler.jsonc`

Frameworks that use `getPlatformProxy()` for local dev (SvelteKit, Nuxt with `nitro-cloudflare-dev`, Astro) need a `wrangler.jsonc`. `voidPlugin()` auto-syncs inferred bindings into this file on dev startup:

```jsonc
{
  "name": "my-sveltekit-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat"],
  // Bindings below are auto-managed by voidPlugin()
}
```

Existing bindings are preserved — only missing ones are added with local placeholder IDs.

For `void deploy`, compatibility settings are read from `wrangler.jsonc` automatically (no need to duplicate them in `void.json`).

## Deploy Pipeline

SvelteKit, Nuxt, and Astro apps follow this pipeline:

```
void deploy
  │
  ├─ 1. Detect framework
  │    Reads package.json → determines framework + output conventions
  │
  ├─ 2. Build
  │    Runs framework's build command (or void.json `build` override)
  │    SvelteKit: vite build → .svelte-kit/cloudflare/
  │    Nuxt:      nuxt build → .output/
  │    Astro:     astro build → dist/
  │
  ├─ 3. Analyze
  │    ├─ Locate worker entry + static assets from known output paths
  │    ├─ Infer bindings from source or read from void.json
  │    ├─ Collect migrations from migrations/*.sql
  │    ├─ Detect auth, cron, and queue handlers
  │    └─ Read wrangler.jsonc compat settings
  │
  ├─ 4. Wrap (if needed)
  │    If auth, crons, or queues are configured:
  │    ├─ Generate wrapper entry module
  │    ├─ Bundle with Vite (wraps framework's worker)
  │    └─ Wrapper adds auth middleware, scheduled/queue handlers
  │
  ├─ 5. Package + upload
  │    Same as full-stack: hash-based asset diffing,
  │    multipart upload, platform provisioning
  │
  └─ 6. Live
       https://my-app.void.app
```

### Build Output Conventions

Each framework has known output paths that the CLI uses to locate the worker and assets:

| Framework | Worker Entry                        | Assets                    |
| --------- | ----------------------------------- | ------------------------- |
| SvelteKit | `.svelte-kit/cloudflare/_worker.js` | `.svelte-kit/cloudflare/` |
| Nuxt      | `.output/server/index.mjs`          | `.output/public/`         |
| Astro     | `dist/_worker.js/index.js`          | `dist/`                   |

## Getting Started

### SvelteKit

1. Install the adapter and Void:

```bash
npm install -D @sveltejs/adapter-cloudflare void
```

2. Configure `svelte.config.js`:

```js
import adapter from "@sveltejs/adapter-cloudflare";

export default {
  kit: { adapter: adapter() },
};
```

3. Add `voidPlugin()` to `vite.config.ts`:

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import { voidPlugin } from "void";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [voidPlugin(), sveltekit()],
});
```

4. Create `wrangler.jsonc` (needed for local dev):

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat"],
}
```

5. Deploy:

```bash
void login
void deploy
```

### Nuxt

1. Install the Cloudflare preset and Void:

```bash
npm install -D void
npx nuxi module add nitro-cloudflare-dev
```

2. Configure `nuxt.config.ts` with `voidPlugin()`:

```ts
import { voidPlugin } from "void";

export default defineNuxtConfig({
  nitro: { preset: "cloudflare-module" },
  vite: { plugins: [voidPlugin()] },
});
```

3. Create `wrangler.jsonc` (for local dev binding sync):

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat"],
}
```

4. Deploy:

```bash
void login
void deploy
```

### Astro

1. Install the Cloudflare adapter and Void:

```bash
npm install -D @astrojs/cloudflare void
```

2. Configure `astro.config.mjs` with `voidPlugin()`:

```js
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { voidPlugin } from "void";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  vite: { plugins: [voidPlugin()] },
});
```

3. Create `wrangler.jsonc` (for local dev binding sync):

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": ["nodejs_compat"],
}
```

4. Deploy:

```bash
void login
void deploy
```
