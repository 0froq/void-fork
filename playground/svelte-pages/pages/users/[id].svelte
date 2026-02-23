<script lang="ts">
  import { Link } from "void/svelte";
  import type { Props } from "./[id].server";

  let { user }: Props = $props();
</script>

<div>
  <h1>{user.name}</h1>
  <p>Email: {user.email}</p>
  <Link href="/users">&larr; Back to Users</Link>
</div>
