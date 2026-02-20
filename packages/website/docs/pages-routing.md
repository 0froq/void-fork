# Pages Routing

Pages is an [Inertia.js](https://inertiajs.com/)-inspired rendering mode that gives you server-driven routing with SPA-like navigation. Think of it as the DX of Remix loaders and actions, but with automatic SSR, client-side page transitions, and no manual hydration setup.

Pages mode activates when a `pages/` directory exists. It coexists with `routes/` — use `pages/` for UI pages and `routes/` for [server routes](./server-routing.md).

## Setup

Install a framework adapter alongside `vite-cloud`:

::: code-group

```sh [React]
npm install @vite-cloud/react
```

```sh [Vue]
npm install @vite-cloud/vue
```

:::

Right now there are only React and Vue support, but more will be coming!

Add both plugins to your Vite config:

::: code-group

```ts [React]
// vite.config.ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudReact } from "@vite-cloud/react/plugin";

export default defineConfig({
  plugins: [viteCloud(), viteCloudReact()],
});
```

```ts [Vue]
// vite.config.ts
import { defineConfig } from "vite";
import viteCloud from "vite-cloud";
import { viteCloudVue } from "@vite-cloud/vue/plugin";

export default defineConfig({
  plugins: [viteCloud(), viteCloudVue()],
});
```

:::

That's it — no SSR entry, no client entry, no hydration boilerplate. The adapter generates everything.

Each adapter plugin includes the framework's Vite plugin (`@vitejs/plugin-react`, `@vitejs/plugin-vue`) so you don't need to install or configure it separately. Pass framework plugin options via `viteCloudReact({ react: { ... } })` or `viteCloudVue({ vue: { ... } })` if needed.

## Directory Structure

Each page is a component file paired with a `.server.ts` file that provides server-side data loading. Pages can be flat files (`about.vue`) or use directory-based routing (`about/index.vue`) — both map to the same route:

::: code-group

```[React]
project/
  pages/                    # UI pages (SSR + SPA navigation)
    layout.tsx              # Root layout
    index.tsx               # GET /
    index.server.ts         # Server handler for /
    about.tsx               # GET /about (flat file)
    about.server.ts         # Server handler for /about
    users/
      layout.tsx            # Nested layout for /users/*
      index.tsx             # GET /users (directory-based)
      index.server.ts       # Server handler for /users
      [id].tsx              # GET /users/:id
      [id].server.ts        # Server handler for /users/:id
  routes/                   # Pure JSON API endpoints
    api/
      health.ts             # GET /api/health -> JSON
  middleware/                # Shared across pages and routes
    01.auth.ts
```

```[Vue]
project/
  pages/                    # UI pages (SSR + SPA navigation)
    layout.vue              # Root layout
    index.vue               # GET /
    index.server.ts         # Server handler for /
    about.vue               # GET /about (flat file)
    about.server.ts         # Server handler for /about
    users/
      layout.vue            # Nested layout for /users/*
      index.vue             # GET /users (directory-based)
      index.server.ts       # Server handler for /users
      [id].vue              # GET /users/:id
      [id].server.ts        # Server handler for /users/:id
  routes/                   # Pure JSON API endpoints
    api/
      health.ts             # GET /api/health -> JSON
  middleware/                # Shared across pages and routes
    01.auth.ts
```

:::

File-based routing rules are the same as [server routing](./server-routing.md): `[param]` for dynamic segments, `[...param]` for catch-all, `(group)/` for route groups.

## Server Handlers

Every page can have a companion `.server.ts` file that exports a `loader` and/or `action`. If you've used Remix, these concepts are familiar. Server handlers use the exact same `defineHandler` API as [server routes](./server-routing.md) — you get the same typed `c.env` bindings, `withValidator()` support, and Hono context methods.

**`loader`** runs on GET requests and returns an object that becomes the page's props:

```ts
// pages/users/index.server.ts
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

export interface Props {
  users: Array<{ id: number; name: string; email: string }>;
}

export const loader = defineHandler<Props>(async (c) => {
  return { users: await db.list("users") };
});
```

**`action`** runs on mutations (POST, PUT, PATCH, DELETE):

```ts
// pages/users/index.server.ts
export const action = defineHandler.withValidator({
  body: createUserSchema,
})(async (c, { body }) => {
  await db.insert("users", body);
  // No return → re-runs loader, page re-renders with fresh data
});
```

| Action returns        | Behavior                                              |
| --------------------- | ----------------------------------------------------- |
| Nothing (void)        | Re-runs the loader, page re-renders with fresh props. |
| `c.redirect('/path')` | Navigates to another page.                            |

Both use the same `defineHandler` API from [server routing](./server-routing.md), including `withValidator()` for input validation.

## Page Components

The component receives loader data as props. Export the props type from your `.server.ts` file to keep the contract in one place:

::: code-group

```tsx [React]
// pages/users/index.tsx
import type { Props } from "./index.server";

export default function UsersPage({ users }: Props) {
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
```

```vue [Vue]
<!-- pages/users/index.vue -->
<script setup lang="ts">
import type { Props } from "./index.server";
defineProps<Props>();
</script>

<template>
  <h1>Users</h1>
  <ul>
    <li v-for="u in users" :key="u.id">{{ u.name }}</li>
  </ul>
</template>
```

:::

### Vue: `<script server>` {#vue-script-server}

Vue pages can optionally colocate server logic directly in the SFC using a <code v-pre>&lt;script server&gt;</code> block, instead of a separate `.server.ts` file:

```vue
<!-- pages/users/index.vue -->
<script server lang="ts">
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

export interface Props {
  users: Array<{ id: number; name: string; email: string }>;
}

export const loader = defineHandler<Props>(async (c) => {
  return { users: await db.list("users") };
});
</script>

<script setup lang="ts">
defineProps<Props>();
</script>

<template>
  <h1>Users</h1>
  <ul>
    <li v-for="u in users" :key="u.id">{{ u.name }}</li>
  </ul>
</template>
```

The `<script server>` block is extracted at build time — runtime code never ships to the client. Type declarations (`interface`, `type`, `import type`) defined in `<script server>` are preserved and available to `<script setup>`, so you can define your props type once and reference it in both blocks.

If both `<script server>` and a `.server.ts` file exist, the `.server.ts` file takes precedence.

## How Navigation Works

Pages uses an Inertia-style protocol under the hood:

| Request               | Response                                                 |
| --------------------- | -------------------------------------------------------- |
| Initial page load     | Full SSR HTML. Client hydrates automatically.            |
| Subsequent navigation | JSON with component name + props. Client swaps the page. |
| Form submission       | Runs action, then returns fresh props or a redirect.     |

This means the first page load is server-rendered for SEO and performance, and all subsequent navigations feel instant — no full page reloads.

Use the `Link` component for SPA navigation between pages. It renders an `<a>` tag that intercepts clicks and navigates without a full page reload:

::: code-group

```tsx [React]
import { Link } from "@vite-cloud/react";

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

```vue [Vue]
<script setup lang="ts">
import { Link } from "@vite-cloud/vue";
</script>

<template>
  <Link href="/users">Users</Link>
  <Link :href="`/users/${id}`">View</Link>
</template>
```

:::

For programmatic navigation, use `useRouter()`:

```ts
import { useRouter } from "@vite-cloud/vue"; // or "@vite-cloud/react"

const router = useRouter();
router.visit("/users");
router.reload(); // re-fetch current page props
router.post("/logout"); // non-GET navigation
```

## Layouts

Place a layout file in any `pages/` directory to wrap all pages in that subtree:

::: code-group

```[React]
pages/
  layout.tsx              # Root layout (nav, footer)
  index.tsx
  users/
    layout.tsx            # Nested layout for /users/*
    index.tsx
    [id].tsx
```

```[Vue]
pages/
  layout.vue              # Root layout (nav, footer)
  index.vue
  users/
    layout.vue            # Nested layout for /users/*
    index.vue
    [id].vue
```

:::

::: code-group

```tsx [React]
// pages/layout.tsx
import { useShared, Link } from "@vite-cloud/react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const { auth } = useShared();
  return (
    <>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/users">Users</Link>
        {auth?.user && <span>{auth.user.name}</span>}
      </nav>
      <main>{children}</main>
    </>
  );
}
```

```vue [Vue]
<!-- pages/layout.vue -->
<script setup lang="ts">
import { useShared, Link } from "@vite-cloud/vue";
const { auth } = useShared();
</script>

<template>
  <nav>
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <span v-if="auth?.user">{{ auth.user.name }}</span>
  </nav>
  <main>
    <slot />
  </main>
</template>
```

:::

Layouts nest automatically (e.g. root layout wraps `users/layout` wraps page component) and persist across navigations within their subtree — component state is preserved.

## Shared Data

Middleware can inject data available on every page via `c.set("shared", {...})`. Augment `CloudContextVariables` to type the shared data, and `useShared()` will infer the type automatically:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from "vite-cloud";

declare module "vite-cloud" {
  interface CloudContextVariables {
    shared: { auth: { user: { name: string } | null } };
  }
}

export default defineMiddleware(async (c, next) => {
  const user = await getSessionUser(c);
  c.set("shared", { auth: { user } });
  await next();
});
```

Access it on the client with `useShared()` — the return type is inferred from your augmentation:

::: code-group

```tsx [React]
import { useShared } from "@vite-cloud/react";

export default function Page() {
  const { auth } = useShared(); // { auth: { user: { name: string } | null } }
  return <p>Hello, {auth?.user?.name}</p>;
}
```

```vue [Vue]
<script setup lang="ts">
import { useShared } from "@vite-cloud/vue";
const { auth } = useShared(); // { auth: { user: { name: string } | null } }
</script>
```

:::

Shared data is separate from page props — props come from the loader, `useShared()` returns global data from middleware. See [Type Safety](./type-safety.md#context-variables) for more on augmenting `CloudContextVariables`.

## Forms and Actions

`useForm` handles form submissions, loading state, and validation errors. It pairs with your page's `action` handler — the form submits to the current page URL, the action processes the mutation, and the page re-renders with fresh data.

::: code-group

```tsx [React]
// pages/users/create.tsx
import { useForm } from "@vite-cloud/react";

export default function CreateUser() {
  const form = useForm({ name: "", email: "" });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post("/users");
      }}
    >
      <input value={form.data.name} onChange={(e) => form.setData("name", e.target.value)} />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input value={form.data.email} onChange={(e) => form.setData("email", e.target.value)} />
      {form.errors.email && <span>{form.errors.email}</span>}

      <button disabled={form.processing}>Create</button>
    </form>
  );
}
```

```vue [Vue]
<!-- pages/users/create.vue -->
<script setup lang="ts">
import { useForm } from "@vite-cloud/vue";

const form = useForm({ name: "", email: "" });

function submit() {
  form.post("/users");
}
</script>

<template>
  <form @submit.prevent="submit">
    <input v-model="form.name" />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>

    <input v-model="form.email" />
    <span v-if="form.errors.email">{{ form.errors.email }}</span>

    <button :disabled="form.processing">Create</button>
  </form>
</template>
```

:::

`useForm` returns a reactive object with:

| Property / Method                | Purpose                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `post`, `put`, `patch`, `delete` | Submit the form with the given HTTP method.               |
| `data` / `setData`               | Current form values (React). Vue uses `v-model` directly. |
| `errors`                         | Field-level validation errors from the server.            |
| `processing`                     | `true` while the submission is in flight.                 |
| `isDirty`                        | `true` if form data differs from initial values.          |
| `reset`                          | Reset form data to initial values.                        |

### Validation Errors

When an action throws a `ValidationError` (or validation fails via `withValidator`), the errors are automatically available on `form.errors` — no manual error handling needed.

Actions can throw `ValidationError` for custom validation logic:

```ts
import { defineHandler, ValidationError } from "vite-cloud";

export const action = defineHandler(async (c) => {
  const body = await c.req.json();
  if (await emailExists(body.email)) {
    throw new ValidationError({ email: "Email already taken" });
  }
  // ...
});
```

Or use `withValidator()` for automatic schema-based validation — errors are returned in the same format.
