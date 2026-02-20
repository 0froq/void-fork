# Typed `useForm()` via Generated Route Types

## Overview

Make `useForm()` type-safe by generating a `PageActionMap` from page action validators and adding a URL-first overload that provides autocomplete, body validation, and typed errors.

## Design

### Type Generation: `PageActionMap`

Extend `routes.d.ts` generation to include a `PageActionMap` interface alongside the existing `RouteMap`. All pages with actions get entries — not just those with validators.

```typescript
// .vite-cloud/routes.d.ts (generated)
export {};
declare module "vite-cloud/routes" {
  // Existing — API routes
  interface RouteMap {
    "/api/users": { GET: { input: {}; output: User[] } };
  }

  // New — page actions
  interface PageActionMap {
    "/users": {
      body: { name: string; email: string };  // from withValidator({ body: schema })
    };
    "/users/:id": {
      body: { name: string };
      params: { id: string };
    };
    "/settings": {
      body: Record<string, unknown>;  // action exists but no validator
    };
  }
}
```

**Rules:**
- All pages with actions get entries (enables URL autocomplete even without validators)
- `body` type extracted from `withValidator({ body: schema })` via existing `__validators` machinery
- Actions without validators get `body: Record<string, unknown>`
- `params` included when route has dynamic segments (`:id`, `:slug`, etc.)
- Only `body` validator is relevant — `query`/`params` validators are ignored for form typing

### `useForm` API: URL-First Overload

Two overloads — typed (URL-first) and untyped (backward compatible):

```typescript
// Typed: bound to a specific page route
function useForm<U extends keyof PageActionMap>(
  url: U,
  defaults: PageActionMap[U]["body"],
  options?: { params: PageActionMap[U] extends { params: infer P } ? P : never }
): TypedForm<PageActionMap[U]>;

// Untyped: backward compatible
function useForm<T extends Record<string, unknown>>(
  defaults: T
): Form<T>;
```

**Usage examples:**

```typescript
// Static route — full typing
const form = useForm("/users", { name: "", email: "" });
form.post();           // posts to "/users"
form.errors.name;      // string | undefined
form.errors.foo;       // TS error

// Dynamic route — params resolve at runtime
const form = useForm("/users/:id", { name: "" }, { params: { id: String(props.user.id) } });
form.post();           // posts to "/users/123"

// Untyped — backward compatible
const form = useForm({ name: "", email: "" });
form.post("/users");   // explicit URL, no type narrowing
```

### Typed Form Return Type

```typescript
interface TypedForm<A extends { body: Record<string, unknown> }> {
  // Reactive data fields (existing behavior, spread onto form object)
  [K in keyof A["body"]]: A["body"][K];

  // Errors narrowed to body field keys
  errors: Partial<Record<keyof A["body"] & string, string>>;

  // Submit methods — URL already bound, no arg needed
  post(opts?: SubmitOptions): void;
  put(opts?: SubmitOptions): void;
  patch(opts?: SubmitOptions): void;
  delete(opts?: SubmitOptions): void;

  // Existing helpers — field args narrowed
  processing: boolean;
  isDirty: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  reset(...fields: (keyof A["body"] & string)[]): void;
  clearErrors(...fields: (keyof A["body"] & string)[]): void;
}
```

For pages without validators (`body: Record<string, unknown>`), errors falls back to `Partial<Record<string, string>>` — no regression from current behavior.

### Dynamic Route Param Resolution

For routes with dynamic segments, params are passed as a third argument and resolved at runtime by replacing `:segment` placeholders:

```typescript
useForm("/users/:id", defaults, { params: { id: "123" } })
// Runtime: posts to "/users/123"
```

This is consistent with the typed `fetch()` client which uses the same `params` pattern.

The `params` option is required (via conditional types) when the route has dynamic segments, and omitted/forbidden for static routes.

## Files Changed

| File | Change |
|------|--------|
| `packages/vite-cloud/src/codegen/route-types.ts` | Generate `PageActionMap` entries from page action handlers |
| `packages/vite-cloud/src/runtime/routes-stub.ts` | Add empty `PageActionMap` interface stub |
| `packages/vue/src/runtime/use-form.ts` | Add URL-first overload, runtime param resolution |
| `packages/vue/src/index.ts` | Re-export updated `useForm` types |

## Edge Cases

- **No `pages/` directory**: `PageActionMap` is empty — typed overload has no valid URLs, untyped overload still works
- **Action without validator**: Entry generated with `body: Record<string, unknown>` — URL autocompletes, body/errors unnarrowed
- **Multiple validators** (body + query): Only `body` extracted for `PageActionMap`
- **`<script server>` vs `.server.ts`**: Both go through same handler loading — type extraction works identically
