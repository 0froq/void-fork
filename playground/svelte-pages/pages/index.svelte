<script lang="ts">
  import { Link } from "@voidcloud/svelte";
  import type { Props } from "./index.server";

  let { title }: Props = $props();
</script>

<div>
  <h1>Welcome — {title}</h1>
  <p>This is the Svelte Pages playground.</p>
  <Link href="/users">Go to Users</Link>
</div>
