<script setup lang="ts">
import { Link } from "@vite-cloud/vue";

const props = defineProps<{
  user: { id: number; name: string; email: string };
}>();
</script>

<template>
  <div>
    <h1>{{ user.name }}</h1>
    <p>Email: {{ user.email }}</p>
    <Link href="/users">&larr; Back to Users</Link>
  </div>
</template>
