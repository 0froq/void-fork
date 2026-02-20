<script setup lang="ts">
import { Link } from "@vite-cloud/vue/runtime";

const props = defineProps<{
  user: { id: number; name: string; email: string; created_at: string };
}>();
</script>

<template>
  <div>
    <h1>{{ user.name }}</h1>
    <p>Email: {{ user.email }}</p>
    <p>Created: {{ user.created_at }}</p>
    <Link href="/users">&larr; Back to Users</Link>
  </div>
</template>
