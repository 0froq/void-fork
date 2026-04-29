<script setup lang="ts">
import type { Props } from './login.server.ts';

const { githubUrl, googleUrl } = defineProps<Props>();
</script>

<template>
  <div class="flex min-h-screen items-center justify-center">
    <div class="w-full max-w-sm border border-border p-8">
      <h1 class="mb-6 font-mono text-lg text-text">void</h1>
      <p class="mb-8 text-sm text-text-secondary">Sign in to your dashboard</p>
      <div class="flex flex-col gap-3">
        <a
          :href="githubUrl"
          class="block border border-border px-4 py-2.5 text-center text-sm text-text transition-colors hover:border-accent hover:bg-accent-bg"
        >
          Continue with GitHub
        </a>
        <a
          :href="googleUrl"
          class="block border border-border px-4 py-2.5 text-center text-sm text-text transition-colors hover:border-accent hover:bg-accent-bg"
        >
          Continue with Google
        </a>
      </div>
    </div>
  </div>
</template>
