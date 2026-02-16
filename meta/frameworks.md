# Meta-Framework Integration

**Date:** February 2026
**Status:** In Progress

---

## 1. Overview

Vite Cloud currently owns the full server stack: Hono-based routing, worker entry generation, and SSR rendering. This works well for projects built directly on the Vite Cloud primitives (`defineHandler`, file-based routing), but many teams already use meta-frameworks like TanStack Start, React Router, or SolidStart.

The `framework` option switches Vite Cloud into **platform sidecar mode** — the framework handles routing and SSR, while Vite Cloud handles bindings, migrations, and deployment.

---

## 2. Landscape Research

### 2.1 Frameworks with Cloudflare Workers Support

| Framework       | CF Workers Support                  | Vite Plugin?      | Entry Point Convention                                     |
| --------------- | ----------------------------------- | ----------------- | ---------------------------------------------------------- |
| TanStack Start  | Yes (via `@cloudflare/vite-plugin`) | `tanstackStart()` | Framework-managed, uses `viteEnvironment: { name: "ssr" }` |
| React Router v7 | Yes (via `@cloudflare/vite-plugin`) | `reactRouter()`   | Framework-managed                                          |
| SolidStart      | Yes (vinxi/nitro-based)             | `solidStart()`    | Nitro preset system                                        |
| Nuxt            | Yes (via NuxtHub/Nitro)             | N/A (own build)   | Nitro `cloudflare-module` preset                           |

### 2.2 How `@cloudflare/vite-plugin` Handles Frameworks

The CF plugin has a `viteEnvironment` option designed for framework integration:

```ts
cloudflare({
  viteEnvironment: { name: "ssr" },
  config: {
    /* bindings */
  },
});
```

When `viteEnvironment` is set:

- The CF plugin does NOT create its own Vite environment
- Instead, it hooks into the environment created by the framework's plugin (e.g., TanStack Start's "ssr" environment)
- The framework controls the worker entry and routing
- The CF plugin provides the workerd runtime and binding resolution

This is the key integration point. Vite Cloud's framework mode uses this same pattern.

### 2.3 How Bindings Are Accessed in Frameworks

In framework mode, users access Cloudflare bindings differently than in Vite Cloud's Hono-based routing:

**TanStack Start / React Router (server functions):**

```ts
import { env } from "cloudflare:workers";

async function getUsers() {
  "use server";
  const result = await env.DB.prepare("SELECT * FROM users").all();
  return result.results;
}
```

**SolidStart (server functions):**

```ts
import { env } from "cloudflare:workers";

async function getUsers() {
  "use server";
  const result = await env.DB.prepare("SELECT * FROM users").all();
  return result.results;
}
```

The `cloudflare:workers` module provides typed access to bindings. The binding inference AST walker already detects `env.DB`, `env.KV`, and `env.STORAGE` patterns from this import style.

---

## 3. Architecture

### 3.1 Default Mode vs Framework Mode

```
Default Mode (no framework option):
  viteCloud() → [routingPlugin, migrationPlugin, ...cloudflare({ config: { main, bindings } })]

Framework Mode (framework: "tanstack-start"):
  viteCloud() → [migrationPlugin, ...cloudflare({ viteEnvironment, config: { bindings } })]
```

Key differences in framework mode:

- **No routing plugin** — framework owns routing
- **No entry.ts generation** — framework controls the worker entry
- **No SSR validation** — framework handles SSR
- **No `config.main`** — framework provides this
- **No `config.assets`** — framework handles asset binding
- **`viteEnvironment: { name: "ssr" }`** — hooks into framework's environment
- **Expanded binding scan dirs** — scans `src/`, `app/`, `routes/`, `server/` (framework conventions)
- **Writes `framework.json`** — so the deploy CLI knows about framework mode

### 3.2 Plugin Composition

In framework mode, the user's `vite.config.ts` looks like:

```ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin";
import react from "@vitejs/plugin-react";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [tanstackStart(), react(), viteCloud({ framework: "tanstack-start" })],
});
```

The framework plugin creates the "ssr" environment. Vite Cloud's CF plugin hooks into it. Migrations still auto-apply on dev startup.

### 3.3 Deploy Behavior

When `.vite-cloud/framework.json` exists after build:

1. Binding inference uses expanded scan dirs
2. SSR is always enabled (frameworks handle their own SSR)
3. Job scanning is skipped (cron jobs require manual wiring in framework mode)
4. Everything else (worker dir detection, packaging, upload) stays the same

---

## 4. Supported Frameworks

### 4.1 TanStack Start (v1.1 — first target)

- Plugin: `@tanstack/react-start/plugin`
- Environment name: `"ssr"`
- Binding access: `import { env } from "cloudflare:workers"` in server functions
- Build output: Standard CF plugin output (worker dir + client dir)

### 4.2 React Router v7 (planned)

- Plugin: `@react-router/dev/vite`
- Environment name: `"ssr"`
- Binding access: Same `cloudflare:workers` pattern
- Notes: Similar integration path to TanStack Start

### 4.3 SolidStart (planned)

- Plugin: `solid-start/vite`
- Notes: Uses vinxi/nitro internally, may need different integration approach

---

## 5. What's NOT Included in Framework Mode

- **File-based routing** — framework handles this
- **`defineHandler` / `defineMiddleware`** — framework has its own patterns
- **Auth routes** — framework mode doesn't generate auth routes (use framework's auth solution)
- **Cron jobs** — `scanJobsSync()` is skipped; users wire cron handlers manually
- **SSR entry validation** — framework owns the SSR entry

What IS included:

- **Binding inference** (expanded scan dirs)
- **Migration plugin** (auto-apply on dev startup)
- **Deploy CLI** (build, package, upload)
- **CF plugin with workerd runtime**
