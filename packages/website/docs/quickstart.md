# Vite Cloud Quickstart

This guide gets a fresh Vite app deployed on Vite Cloud in a few minutes.

## Prerequisites

- Node.js 20+

## 1. Create a new Vite app

```bash
npm create vite@latest my-app
cd my-app
npm install
```

## 2. Install Vite Cloud

```bash
npm install -D vite-cloud
```

## 3. Enable the plugin in `vite.config.ts`

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [viteCloud()],
});
```

## 4. Add your first API route

Create `routes/api/hello.get.ts`:

```ts
import { defineHandler } from "vite-cloud";

export default defineHandler((c) => {
  return c.json({ message: "Hello from Vite Cloud" });
});
```

## 5. Run locally

```bash
npm run dev
```

Then visit:

- App: `http://localhost:5173`
- API route: `http://localhost:5173/api/hello`

## 6. Log in

```bash
npx vite-cloud login
```

You can also use the short binary:

```bash
npx vcd login
```

## 7. Deploy

Set secrets once before deploying:

```bash
npx vcd secret put KEY=value
```

Then run:

```bash
npx vcd deploy
```

On first deploy, Vite Cloud will:

- build your app
- create or link a project
- provision required resources (for example D1/KV/R2 when inferred)
- deploy to `https://<slug>.vitecloud.app`

## 8. Optional: deploy to a specific project slug

Useful for CI or multi-project accounts:

```bash
npx vcd deploy --project my-app
```

Or via env var:

```bash
VITE_CLOUD_PROJECT=my-app npx vcd deploy
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
