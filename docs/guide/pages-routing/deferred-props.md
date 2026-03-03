---
outline: deep
---

# Deferred Props

Loaders sometimes need to fetch data that's slow — analytics, external APIs, AI inference. `defer()` lets you return a placeholder immediately so the page renders fast, then streams the real data as it resolves:

```ts
// pages/dashboard.server.ts
import { defineHandler, defer } from "void";
import type { InferProps } from "void";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const projects = await db.list("projects"); // fast — returns immediately
  return {
    projects,
    usage: defer(async () => {
      return await fetchUsageMetrics(); // slow — streams when ready
    }),
  };
});
```

The page renders immediately with `projects` available. The `usage` prop starts in a loading state and resolves once the deferred function completes — no waterfall, no blocking.

## Handling Deferred State

`Deferred<T>` is a [discriminated union](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions) with three states:

```ts
type Deferred<T> =
  | { loading: true; value: null; error: null } // pending
  | { loading: false; value: T; error: null } // resolved
  | { loading: false; value: null; error: Error }; // rejected
```

Check `loading` first, then `error` — TypeScript narrows `value` to `T` in the resolved branch:

::: code-group

```tsx [React]
import type { Props } from "./dashboard.server";

export default function Dashboard({ projects, usage }: Props) {
  return (
    <div>
      <h1>Projects ({projects.length})</h1>
      {usage.loading ? (
        <p>Loading usage...</p>
      ) : usage.error ? (
        <p>Failed: {usage.error.message}</p>
      ) : (
        <p>{usage.value.requests} requests</p>
      )}
    </div>
  );
}
```

```vue [Vue]
<script setup lang="ts">
import type { Props } from "./dashboard.server";
defineProps<Props>();
</script>

<template>
  <div>
    <h1>Projects ({{ projects.length }})</h1>
    <p v-if="usage.loading">Loading usage...</p>
    <p v-else-if="usage.error">Failed: {{ usage.error.message }}</p>
    <p v-else>{{ usage.value.requests }} requests</p>
  </div>
</template>
```

```svelte [Svelte]
<script lang="ts">
  import type { Props } from "./dashboard.server";
  let { projects, usage }: Props = $props();
</script>

<div>
  <h1>Projects ({projects.length})</h1>
  {#if usage.loading}
    <p>Loading usage...</p>
  {:else if usage.error}
    <p>Failed: {usage.error.message}</p>
  {:else}
    <p>{usage.value.requests} requests</p>
  {/if}
</div>
```

```tsx [Solid]
import type { Props } from "./dashboard.server";

export default function Dashboard(props: Props) {
  return (
    <div>
      <h1>Projects ({props.projects.length})</h1>
      {props.usage.loading ? (
        <p>Loading usage...</p>
      ) : props.usage.error ? (
        <p>Failed: {props.usage.error.message}</p>
      ) : (
        <p>{props.usage.value.requests} requests</p>
      )}
    </div>
  );
}
```

:::

## How It Works

On the initial page load (SSR), the page renders with deferred props in their loading state. As each deferred function resolves, the server streams an inline `<script>` tag that delivers the data — no extra HTTP request needed. On SPA navigation, deferred data streams via NDJSON over the same response.

## Grouped Deferred Props

When multiple props depend on the same slow operation, use a named group to resolve them together with a single function call:

```ts
export const loader = defineHandler<Props>(async (c) => {
  const analyticsResolver = async () => {
    const data = await fetchAnalytics(); // one slow call
    return { metrics: data.metrics, chart: data.chart };
  };

  return {
    projects: await db.list("projects"),
    metrics: defer("analytics", analyticsResolver),
    chart: defer("analytics", analyticsResolver),
  };
});
```

Both `metrics` and `chart` resolve from a single invocation of the analytics resolver. The component receives them as separate `Deferred<T>` props.
