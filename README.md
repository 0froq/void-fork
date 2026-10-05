# Void

Full-stack apps with [Vite](https://vite.dev), running on Cloudflare Workers.

Build APIs and server-rendered pages with typed access to databases, storage, and AI. Void detects the resources your app uses and provisions them when you deploy. Use React, Vue, Svelte, Solid, or a [supported framework](https://void.cloud/integrations/frameworks/overview).

## Getting Started

Use Node.js 24.21.0 or later. In an empty directory, run:

```sh
npm install -D void
npx void init
npm run dev
```

Choose your UI framework and starter, then select Cloudflare to deploy to your account:

```sh
npx void deploy
```

Void builds the app, provisions resources, applies database migrations, and prints your deployed URL. Follow the [Quickstart](https://void.cloud/guide/quickstart) to explore your app or add Void to an existing Vite project.

## Documentation

- [How Void works](https://void.cloud/guide/)
- [Server routes](https://void.cloud/guide/server-routing) and [pages](https://void.cloud/guide/pages-routing/overview)
- [Database](https://void.cloud/guide/database) and [type safety](https://void.cloud/guide/type-safety)
- [Deployment](https://void.cloud/guide/deployment)
- [Framework integrations](https://void.cloud/integrations/frameworks/overview)
- [Coding agents](https://void.cloud/integrations/agents)

Teams can [install a Void platform](https://void.cloud/guide/self-hosted-platform) in a shared Cloudflare account. The framework, CLI, and platform source are included in this repository.

## Contributing

```sh
git clone https://github.com/voidzero-dev/void.git
cd void
vp install
vp run build:all
```

Use `vp run dev:docs` to preview the docs. See [TESTING.md](./TESTING.md) for verification, [Platform Development](https://void.cloud/guide/platform-development) for platform changes, and [operations](./platform/meta/operations.md) for repository deployments.

## License

MIT
