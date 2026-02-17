# Type Safety

Vite Cloud generates end-to-end type safety from your route handlers to your client code — no manual type annotations needed.

## How It Works

When `vite dev` or `vite build` runs, the routing plugin:

1. Scans `routes/` for files with named HTTP method exports
2. Generates `.vite-cloud/routes.d.ts` — a TypeScript declaration file that maps every route to its input and output types
3. Uses `typeof import(...)` to resolve types directly from your handler source code

The generated `RouteMap` is used by the typed `fetch` client to provide autocomplete and type checking for paths, methods, request bodies, and response types.

## Setting Up `tsconfig.json`

Extend the generated tsconfig in your project's `tsconfig.json`:

```json
{
  "extends": "./.vite-cloud/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "types": ["vite-cloud/env"]
  },
  "include": ["src", "routes", "middleware"]
}
```

The `"extends"` line is the key part. The generated `.vite-cloud/tsconfig.json` includes `routes.d.ts` via its `files` field, which TypeScript inherits automatically. You do not need to add `.vite-cloud` to your `include` array.

> **Note:** The `.vite-cloud/tsconfig.json` and `routes.d.ts` files are generated when the dev server starts or when you build. Run `vite dev` or `vite build` at least once to generate them.

## Typed Fetch Client

Import `fetch` from `vite-cloud/client` to get a fully typed API client:

```ts
import { fetch } from "vite-cloud/client";

// Return type inferred from your GET handler
const users = await fetch("/api/users");

// Method + body type-checked against your POST handler's validator
await fetch("/api/users", {
  method: "POST",
  body: { name: "Alice", email: "alice@example.com" },
});

// Dynamic params interpolated from the path pattern
const user = await fetch("/api/users/:id", {
  params: { id: "42" },
});
```

The client provides:

- **Path autocomplete** — only paths defined in `routes/` are accepted
- **Method validation** — only methods exported from the route file are allowed
- **Input type checking** — `body`, `query`, and `params` are typed based on [validators](./routing.md#validation)
- **Output type inference** — the return type matches what your handler returns, after JSON serialization (e.g. `Date` becomes `string`, functions are stripped)

Under the hood, `fetch` calls `globalThis.fetch` with JSON serialization, path interpolation, and query string construction. Non-OK responses throw a `FetchError` with the `response` and `status` attached.

### Validators and input types

When you use `defineHandler.withValidator()`, the validator schemas become part of the route's input type in the `RouteMap`. The typed client enforces these at the call site:

```ts
// In routes/api/search.ts:
export const GET = defineHandler.withValidator({
  query: z.object({ q: z.string(), page: z.string().optional() }),
})((c, { query }) => {
  return { results: [], query: query.q };
});

// In client code:
const data = await fetch("/api/search", {
  query: { q: "hello" }, // ✓ type-checked
});
// data is typed as { results: never[]; query: string }
```

Routes without validators have an empty input type — no `body`, `query`, or `params` are required.

## Serialization

The type system models JSON serialization. The `Serialize<T>` type transform is applied to handler return types:

| Source type                       | Serialized type                                           |
| --------------------------------- | --------------------------------------------------------- |
| `string`, `number`, `boolean`     | unchanged                                                 |
| `Date`                            | `string`                                                  |
| `Response`                        | excluded (passed through at runtime, not in typed output) |
| `bigint`, `Function`, `undefined` | excluded                                                  |
| `Array<T>`                        | `Array<Serialize<T>>`                                     |
| `{ key: T }`                      | `{ key: Serialize<T> }` (function-valued keys stripped)   |
