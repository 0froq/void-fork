<template>
  <div>
    <h1>Welcome</h1>
    <p>This is the Vue Pages playground.</p>
    <Link href="/users">Go to Users</Link>
  </div>
</template>

<script server lang="ts">
import { defineHandler } from "vite-cloud";

export const GET = defineHandler(() => {
  return { title: "Home" };
});
</script>

<script setup lang="ts">
import { Link } from "@vite-cloud/vue/runtime";

const props = defineProps<{ title: string }>();
</script>
