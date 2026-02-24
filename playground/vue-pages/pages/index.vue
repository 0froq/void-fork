<script setup lang="ts">
import { Link } from "void/vue";
import type { Props } from "./index.server";

defineProps<Props>();
</script>

<template>
  <div>
    <h1>Welcome</h1>
    <p>This is the Vue Pages playground.</p>
    <Link href="/users">Go to Users</Link>
  </div>
</template>
