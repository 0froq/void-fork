<script setup lang="ts">
import { Link, useShared } from "@vite-cloud/vue/runtime";

const shared = useShared<{ appName: string }>();
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
