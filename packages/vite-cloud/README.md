# vite-cloud

The Vite plugin for deploying full-stack apps to [Vite Cloud](https://vite.cloud). File-based API routing, typed database queries, and one-command deploys.

## Quick Start

```bash
npm create vite-cloud@latest
```

Or add to an existing Vite project:

```bash
npm install vite-cloud hono
```

```ts
// vite.config.ts
import viteCloud from "vite-cloud";

export default {
  plugins: [viteCloud()],
};
```

## Features

- **File-based API routing** on [Hono](https://hono.dev) with named HTTP method exports
- **Typed database** with auto-generated types from SQL migrations
- **Typed fetch client** with full route inference
- **Input validation** via any [Standard Schema](https://github.com/standard-schema/standard-schema) library (Zod, Valibot, ArkType)
- **Zero-config deploy** to Cloudflare's edge network

## Documentation

Full documentation is available at **[vite.cloud/docs](https://vite.cloud/docs)**.

## License

MIT
