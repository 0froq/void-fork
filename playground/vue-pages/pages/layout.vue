<script setup lang="ts">
import { Link, useShared } from "@vite-cloud/vue";

const shared = useShared();
</script>

<template>
  <div>
    <nav>
      <Link href="/">Home</Link> | <Link href="/users">Users</Link> |
      <span>{{ shared.appName }}</span>
    </nav>
    <hr />
    <slot />
  </div>
</template>
