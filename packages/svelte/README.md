# @void/svelte

Build server-rendered Void pages with Svelte 5, server loaders, and typed forms.

## Setup

Install alongside `void`:

```sh
npm install @void/svelte
```

Add the adapter to your Vite config. It includes the framework's Vite plugin:

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidSvelte } from '@void/svelte/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

Follow [Pages Routing](https://void.cloud/guide/pages-routing/overview) to add pages, then use [loaders](https://void.cloud/guide/pages-routing/loaders), [forms](https://void.cloud/guide/pages-routing/actions-and-forms), and [layouts](https://void.cloud/guide/pages-routing/layouts).

See the [adapter API reference](https://void.cloud/reference/api/pages) for plugin options and runtime helpers, and [TESTING.md](../../TESTING.md) for repository verification.
