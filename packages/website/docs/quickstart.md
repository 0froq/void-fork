# Vite Cloud Quickstart

## Start in an Empty Directory

::: code-group

```sh [npm]
npm install -D vite-cloud
npx vcc init
```

```sh [pnpm]
pnpm add -D vite-cloud
pnpm vcc init
```

```sh [yarn]
yarn add -D vite-cloud
yarn vcc init
```

```sh [bun]
bun add -D vite-cloud
bunx vcc init
```

:::

This scaffolds a starter Vite Cloud app with an interactive setup flow.

<details>
<summary style="cursor:pointer">
💡 <b>Notes on <code>vcc</code> binary usage</b>
</summary>

`vcc` is a local binary from the installed `vite-cloud` package, so outside of npm scripts, you will have to invoke it with `npx`, `pnpm`, `yarn`, or `bunx`. For brevity, you will sometimes see unprefixed `vcc` usage throughout the docs. Just remember it needs to be invoked through a binary runner.

Alternatively, you can add `./node_modules/.bin` to your `PATH` so that you can invoke `vcc` directly when you are in the root directory of your app.

:::warning ⚠️ Prefer local install
We do not recommend installing `vite-cloud` globally, because the CLI needs to be in sync with same version of the runtime framework. Always install `vite-cloud` locally as a dev dependency of your project.
:::

</details>

## Using with Coding Agents

`vcc init` detects your agent once and reuses that choice for instructions, skills linking, and MCP config.

If auto-detection fails, `vcc init` asks you to choose from a short list (Claude, Cursor, Codex, Gemini CLI, Generic).

In supported agents such as Claude Code, you can invoke the `/vite-cloud` skill to turn your agent into a Vite Cloud export. Then, simply ask the agent to build an app with Vite Cloud.

## Adding to an Existing Vite App

::: warning ⚠️ Framework Compatibility
Currently, not all Vite-based meta frameworks are fully supported, but they should be eventually. See [App Types](./app-types) for details.
:::

::: code-group

```sh [npm]
npm install -D vite-cloud
```

```sh [pnpm]
pnpm add -D vite-cloud
```

```sh [yarn]
yarn add -D vite-cloud
```

```sh [bun]
bun add -D vite-cloud
```

:::

Enable the plugin in `vite.config.ts`

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

Then run the setup guide via `vcc` (Vite Cloud CLI):

::: code-group

```sh [npm]
npx vcc init
```

```sh [pnpm]
pnpm vcc init
```

```sh [yarn]
yarn vcc init
```

```sh [bun]
bunx vcc init
```

:::

## Once You Have a Working App

### 1. Add your first API route

Create `routes/api/hello.get.ts`:

```ts
import { defineHandler } from "vite-cloud";

export default defineHandler((c) => {
  return c.json({ message: "Hello from Vite Cloud" });
});
```

### 2. Run locally

```sh
npm run dev
```

Then visit:

- App: `http://localhost:5173`
- API route: `http://localhost:5173/api/hello`

### 3. Log in

```sh
vcc login
```

### 4. Deploy

Set secrets once before deploying, if any:

```sh
vcc secret put KEY=value
```

Then run:

```sh
vcc deploy
```

```sh
┌  vite-cloud deploy
│
◇  Building...
│  (vite build output)
│
ℹ  Found N migration(s)
│
◇  Checking assets...
◇  Uploading X/Y assets (Z cached)
◇  Packaging...
◇  Deploying...
◇  Deployed!
│
│  ╭─────────────────────────────────────────╮
│  │  https://my-app.vitecloud.app           │
│  │                                         │
│  │  2 worker module(s), 5 static asset(s)  │
│  │  1 migration(s) applied                 │
│  │  SSR enabled                            │
│  ╰─────────────────────────────────────────╯
│
└  Done!
```

On first deploy, Vite Cloud will:

- build your app
- create or link a project
- provision required resources (for example D1/KV/R2 when inferred)
- deploy to `https://<slug>.vitecloud.app`

Right now, only deploys via the CLI is supported. To setup push-to-deploy GitHub, run `vcc init --github`.

## Next steps

- To understand what kind of apps are supported: [App Types](./app-types)
- [Server Routing](./server-routing) — dynamic params, middleware, and validation
- [Database](./db) — queries, migrations, and generated types
- [Type Safety](./type-safety) — end-to-end typed fetch client
