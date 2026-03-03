---
outline: deep
---

# Forms

`useForm` handles form submissions, loading state, and validation errors. It is **fully typed end-to-end** — the URL autocompletes to pages that have an `action`, `form.data` is typed to match the action's validator schema, and `form.errors` keys are constrained to the body's field names. No manual type annotations needed.

## Usage

First, define the action in your server handler:

```ts
// pages/users/create.server.ts
import { defineHandler } from "void";
import { db } from "void/db";
import * as v from "valibot";

const createUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.email()),
});

export const action = defineHandler.withValidator({
  body: createUserSchema,
})(async (c, { body }) => {
  await db.insert("users", body);
  return c.redirect("/users");
});
```

Then, use `useForm` in the page component to submit to this action:

::: code-group

```tsx [React]
// pages/users/create.tsx
import { useForm } from "void/react";

export default function CreateUser() {
  // "/users/create" autocompletes; { name, email } is typed from the action's validator
  const form = useForm("/users/create", { name: "", email: "" });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post();
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
import { useForm } from "void/vue";

// "/users/create" autocompletes; { name, email } is typed from the action's validator
const form = useForm("/users/create", { name: "", email: "" });
</script>

<template>
  <form @submit.prevent="form.post()">
    <input v-model="form.data.name" />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>

    <input v-model="form.data.email" />
    <span v-if="form.errors.email">{{ form.errors.email }}</span>

    <button :disabled="form.processing">Create</button>
  </form>
</template>
```

```svelte [Svelte]
<!-- pages/users/create.svelte -->
<script>
  import { useForm } from "void/svelte";

  // "/users/create" autocompletes; { name, email } is typed from the action's validator
  const form = useForm("/users/create", { name: "", email: "" });
</script>

<form onsubmit={(e) => { e.preventDefault(); form.post(); }}>
  <input bind:value={form.data.name} />
  {#if form.errors.name}<span>{form.errors.name}</span>{/if}

  <input bind:value={form.data.email} />
  {#if form.errors.email}<span>{form.errors.email}</span>{/if}

  <button disabled={form.processing}>Create</button>
</form>
```

```tsx [Solid]
// pages/users/create.tsx
import { useForm } from "void/solid";

export default function CreateUser() {
  // "/users/create" autocompletes; { name, email } is typed from the action's validator
  const form = useForm("/users/create", { name: "", email: "" });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post();
      }}
    >
      <input value={form.data.name} onInput={(e) => form.setData("name", e.target.value)} />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input value={form.data.email} onInput={(e) => form.setData("email", e.target.value)} />
      {form.errors.email && <span>{form.errors.email}</span>}

      <button disabled={form.processing}>Create</button>
    </form>
  );
}
```

:::

The types are inferred from your action's `withValidator()` schema in the companion `.server.ts` file. If no validator is defined, the body type falls back to `Record<string, unknown>` — you still get URL autocomplete either way.

## API Reference

`useForm` returns a reactive object with:

| Property / Method                | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `data` / `setData`               | Current form values, typed to match the action's body schema.  |
| `errors`                         | Field-level validation errors, keys typed to body field names. |
| `post`, `put`, `patch`, `delete` | Submit the form (URL is already bound).                        |
| `processing`                     | `true` while the submission is in flight.                      |
| `isDirty`                        | `true` if form data differs from initial values.               |
| `reset(...fields)`               | Reset form data to initial values. Field names autocomplete.   |
| `clearErrors(...fields)`         | Clear validation errors. Field names autocomplete.             |

For dynamic routes, pass `params` in the options:

```ts
// pages/users/[id].server.ts has an action
const form = useForm("/users/:id", { name: "" }, { params: { id: "42" } });
form.put(); // submits to /users/42
```

## Validation Errors

When an action throws a `ValidationError` (or validation fails via `withValidator`), the errors are automatically available on `form.errors` — no manual error handling needed.

Actions can throw `ValidationError` for custom validation logic:

```ts
import { defineHandler, ValidationError } from "void";

export const action = defineHandler(async (c) => {
  const body = await c.req.json();
  if (await emailExists(body.email)) {
    throw new ValidationError({ email: "Email already taken" });
  }
  // ...
});
```

Or use `withValidator()` for automatic schema-based validation — errors are returned in the same format.

## File Uploads

`useForm` automatically detects `File`, `Blob`, and `FileList` values in form data and sends the request as `multipart/form-data` instead of JSON. No configuration needed — just set a file on the form data and submit.

::: code-group

```tsx [React]
import { useForm } from "void/react";
import { useRef } from "react";

export default function Upload() {
  const form = useForm("/photos", { title: "", photo: null as File | null });
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post();
      }}
    >
      <input value={form.data.title} onChange={(e) => form.setData("title", e.target.value)} />
      <input
        type="file"
        ref={inputRef}
        onChange={(e) => form.setData("photo", e.target.files?.[0] ?? null)}
      />
      <button disabled={form.processing}>Upload</button>
    </form>
  );
}
```

```vue [Vue]
<script setup lang="ts">
import { ref } from "vue";
import { useForm } from "void/vue";

const form = useForm("/photos", { title: "", photo: null as File | null });
const fileInput = ref<HTMLInputElement>();

function onFileChange() {
  form.data.photo = fileInput.value?.files?.[0] ?? null;
}
</script>

<template>
  <form @submit.prevent="form.post()">
    <input v-model="form.data.title" />
    <input type="file" ref="fileInput" @change="onFileChange" />
    <button :disabled="form.processing">Upload</button>
  </form>
</template>
```

```svelte [Svelte]
<script>
  import { useForm } from "void/svelte";

  const form = useForm("/photos", { title: "", photo: null });
</script>

<form onsubmit={(e) => { e.preventDefault(); form.post(); }}>
  <input bind:value={form.data.title} />
  <input type="file" onchange={(e) => { form.data.photo = e.target.files?.[0] ?? null; }} />
  <button disabled={form.processing}>Upload</button>
</form>
```

```tsx [Solid]
import { useForm } from "void/solid";

export default function Upload() {
  const form = useForm("/photos", { title: "", photo: null as File | null });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post();
      }}
    >
      <input value={form.data.title} onInput={(e) => form.setData("title", e.target.value)} />
      <input type="file" onChange={(e) => form.setData("photo", e.target.files?.[0] ?? null)} />
      <button disabled={form.processing}>Upload</button>
    </form>
  );
}
```

:::

On the server, use `c.req.parseBody()` to access the uploaded file:

```ts
// pages/photos.server.ts
import { defineHandler } from "void";
import { storage } from "void/storage";

export const action = defineHandler(async (c) => {
  const body = await c.req.parseBody();
  const file = body["photo"] as File;
  if (file && file.size > 0) {
    await storage.put(file.name, file.stream(), {
      httpMetadata: { contentType: file.type },
    });
  }
});
```
