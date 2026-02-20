# Vite Cloud Quickstart

## Create a new Project

::: code-group

```sh [npm]
npm create vite-cloud
```

```sh [pnpm]
pnpm create vite-cloud
```

```sh [yarn]
yarn create vite-cloud
```

```sh [bun]
bun create vite-cloud
```

## Using with Coding Agents

The fastest way to get started is to copy the prompt below and paste it into your coding agent (Claude Code, Cursor, Codex, etc.):

<<< ../../vite-cloud/getting-started-prompt.txt

You can also pipe it directly into Claude Code:

```sh
vcc agent-prompt | claude
```

For existing projects, run `vcc init --agent` to add a `CLAUDE.md` (or `AGENTS.md`) with framework instructions.

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

Then run the interactive setup guide via `vcc` (Vite Cloud CLI):

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

::: tip Tip: `vcc` binary invocation
`vcc` is a local binary from the installed `vite-cloud` package, so outside of npm scripts, you will have to invoke it with `npx`, `pnpm`, `yarn`, or `bunx`.

Alternatively, you can add `./node_modules/.bin` to your `PATH` so that you can invoke `vcc` directly when you are in the root directory of your app.

**For brevity, we will used unprefixed `vcc` throughout the docs.**
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
