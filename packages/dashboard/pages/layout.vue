<script setup lang="ts">
import "../app.css";
import { Link, useShared } from "@void-x/vue";

const shared = useShared<{ user: { login: string } | null }>();
</script>

<template>
  <div class="min-h-screen bg-bg text-text">
    <!-- Top bar -->
    <nav
      v-if="shared.user"
      class="flex items-center justify-between border-b border-border px-6 py-3"
    >
      <div class="flex items-center gap-6">
        <Link href="/" class="font-mono text-sm text-accent">void</Link>
        <Link href="/" class="text-sm text-text-secondary transition-colors hover:text-text">
          Projects
        </Link>
        <Link
          href="/settings"
          class="text-sm text-text-secondary transition-colors hover:text-text"
        >
          Settings
        </Link>
      </div>
      <div class="flex items-center gap-4">
        <span class="font-mono text-sm text-text-secondary">{{ shared.user.login }}</span>
        <Link href="/logout" class="text-xs text-text-muted transition-colors hover:text-text">
          Logout
        </Link>
      </div>
    </nav>

    <!-- Page content -->
    <main class="mx-auto max-w-5xl px-6 py-8">
      <slot />
    </main>
  </div>
</template>
