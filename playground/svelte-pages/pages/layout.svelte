<script lang="ts">
  import { Link, useShared } from "void/svelte";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
  const shared = useShared();
</script>

<div>
  <nav>
    <Link href="/">Home</Link> | <Link href="/users">Users</Link> |
    <span>{shared.appName}</span>
  </nav>
  <hr />
  {@render children()}
</div>
