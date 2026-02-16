# Configuration

`viteCloud()` accepts an optional config object:

```ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";

export default defineConfig({
  plugins: [
    viteCloud({
      bindings: {
        db: true,
        kv: false,
        storage: false,
      },
    }),
  ],
});
```

## Options

### `bindings`

Explicitly control inferred Cloudflare bindings.

Type:

```ts
{
  db?: boolean;
  kv?: boolean;
  storage?: boolean;
}
```

Behavior:

- If omitted, bindings are inferred by scanning `routes/` and `middleware/` usage (`c.env.DB`, `c.env.KV`, `c.env.STORAGE`).
- If provided, explicit values take precedence over inference.
