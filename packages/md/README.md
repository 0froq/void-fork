# @void/md

Add Markdown routes to Void Pages with frontmatter, syntax highlighting, layouts, and interactive islands.

## Setup

Install alongside `void` and your framework adapter:

```sh
npm install @void/md
```

Add `voidMarkdown()` after the adapter in your Vite config. For example, with Vue:

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { voidVue } from '@void/vue/plugin';
import { voidMarkdown } from '@void/md/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), voidMarkdown()],
});
```

Create `.md` files in `pages/`. The plugin also works with React, Svelte, and Solid.

See [Markdown](https://void.cloud/guide/pages-routing/markdown) for frontmatter, themes, navigation, and plugin options, and [Islands](https://void.cloud/guide/pages-routing/islands) for interactive components. Repository verification is documented in [TESTING.md](../../TESTING.md).
