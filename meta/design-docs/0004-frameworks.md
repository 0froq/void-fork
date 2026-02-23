# Meta-Framework Integration

**Date:** 2026-02-16
**Status:** Implemented

---

## Overview

Void supports two modes: **default mode** (Hono-based routing, full feature set) and **framework mode** (framework handles routing/SSR, Void handles bindings, migrations, deployment).

Framework mode is **auto-detected** via `detectFramework()` — no manual `framework` option needed. Detection looks for framework-specific dependencies in `package.json`.

---

## Architecture

```
Default Mode:
  voidPlugin() → [routingPlugin, dbTypesPlugin, migrationPlugin, ...cloudflare({ config: { main, bindings } })]

Framework Mode:
  voidPlugin() → [dbTypesPlugin, migrationPlugin, ...cloudflare({ viteEnvironment: { name: "ssr" }, config: { bindings } })]
```

Key differences in framework mode:

- **No routing plugin** — framework owns routing
- **No entry.ts generation** — framework controls worker entry
- **No `config.main`** — framework provides this
- **`viteEnvironment: { name: "ssr" }`** — hooks into framework's environment
- **Expanded binding scan dirs** — scans `src/`, `app/`, `routes/`, `server/`

What IS included in framework mode:

- Binding inference (expanded scan dirs)
- Migration plugin (auto-apply on dev startup)
- DB type codegen
- Deploy CLI
- CF plugin with workerd runtime

---

## Binding Access in Frameworks

Framework server functions use `cloudflare:workers` for binding access:

```ts
import { env } from "cloudflare:workers";

async function getUsers() {
  "use server";
  const result = await env.DB.prepare("SELECT * FROM users").all();
  return result.results;
}
```

The binding inference AST walker detects `env.DB`, `env.KV`, `env.STORAGE` from this import style.

---

## Supported Frameworks

| Framework       | Detection                       | Environment Name | Status      |
| --------------- | ------------------------------- | ---------------- | ----------- |
| TanStack Start  | `@tanstack/react-start` in deps | `"ssr"`          | Implemented |
| React Router v7 | `@react-router/dev` in deps     | `"ssr"`          | Implemented |
| SolidStart      | `solid-start` in deps           | TBD              | Planned     |

---

## Plugin Composition

```ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin";
import react from "@vitejs/plugin-react";
import voidPlugin from "void";

export default defineConfig({
  plugins: [tanstackStart(), react(), voidPlugin()],
  // framework mode auto-detected — no explicit option needed
});
```
