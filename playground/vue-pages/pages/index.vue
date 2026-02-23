<script server lang="ts">
import { defineHandler } from "void";

interface Props {
  title: string;
}

export const loader = defineHandler<Props>(() => {
  return { title: "Home" };
});
</script>

<script setup lang="ts">
import { Link } from "@voidcloud/vue";

defineProps<Props>();
</script>

<template>
  <div>
    <h1>Welcome</h1>
    <p>This is the Vue Pages playground.</p>
    <Link href="/users">Go to Users</Link>
  </div>
</template>
