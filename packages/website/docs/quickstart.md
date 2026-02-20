# Vite Cloud Quickstart

This guide gets a fresh Vite app deployed on Vite Cloud in a few minutes.

## Prerequisites

- Node.js 20+

## Using with Coding Agents

The fastest way to get started is to copy the prompt below and paste it into your coding agent (Claude Code, Cursor, Codex, etc.):

```
Vite Cloud is a fullstack Vite framework and deployment platform for Cloudflare. Scaffold a new app with:

npm create vite-cloud@latest my-app
cd my-app
npm install

The scaffolded project includes a CLAUDE.md (or AGENTS.md) file with detailed framework instructions covering routing, database, auth, typed fetch, and more. Read it before building.

Now ask me what I want to build.
```

You can also pipe it directly into Claude Code:

```bash
npx vcc agent-prompt | claude
```

For existing projects, run `npx vcc init --agent` to add a `CLAUDE.md` (or `AGENTS.md`) with framework instructions.

## Manual Setup

### 1. Create a new Vite app

```bash
npm create vite@latest my-app
cd my-app
npm install
```

### 2. Install Vite Cloud

```bash
npm install -D vite-cloud
```

### 3. Enable the plugin in `vite.config.ts`

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

### 4. Add your first API route

Create `routes/api/hello.get.ts`:

```ts
import { defineHandler } from "vite-cloud";

export default defineHandler((c) => {
  return c.json({ message: "Hello from Vite Cloud" });
});
```

### 5. Run locally

```bash
npm run dev
```

Then visit:

- App: `http://localhost:5173`
- API route: `http://localhost:5173/api/hello`

### 6. Log in

```bash
npx vite-cloud login
```

You can also use the short binary:

```bash
npx vcc login
```

### 7. Deploy

Set secrets once before deploying:

```bash
npx vcc secret put KEY=value
```

Then run:

```bash
npx vcc deploy
```

On first deploy, Vite Cloud will:

- build your app
- create or link a project
- provision required resources (for example D1/KV/R2 when inferred)
- deploy to `https://<slug>.vitecloud.app`

### 8. Optional: deploy to a specific project slug

Useful for CI or multi-project accounts:

```bash
npx vcc deploy --project my-app
```

Or via env var:

```bash
VITE_CLOUD_PROJECT=my-app npx vcc deploy
```

Precedence is:

1. `--project <slug>`
2. `VITE_CLOUD_PROJECT`
3. `.vite-cloud/project.json` (linked project in repo)

## Notes

- If you need non-interactive auth in CI, provide `VITE_CLOUD_TOKEN`.

## Next steps

- [Routing](./routing.md) — dynamic params, middleware, and validation
- [App Types](./app-types.md) — SPA, SSR, SSG, ISR, and meta-framework modes
- [Database](./db.md) — queries, migrations, and generated types
- [Type Safety](./type-safety.md) — end-to-end typed fetch client
