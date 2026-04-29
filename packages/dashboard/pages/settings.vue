<script setup lang="ts">
import type { Props } from './settings.server.ts';

const { user } = defineProps<Props>();

function formatLimit(n: number): string {
  if (n === 0) {
    return 'Unlimited';
  }
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(0)} GB`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(0)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}K`;
  }
  return n.toString();
}
</script>

<template>
  <div>
    <h1 class="mb-8 font-mono text-lg">Settings</h1>

    <!-- Profile -->
    <section class="mb-8">
      <h2 class="mb-3 font-mono text-xs uppercase tracking-wider text-text-muted">Profile</h2>
      <div class="divide-y divide-border border border-border">
        <div class="flex items-center justify-between p-3">
          <span class="text-xs text-text-secondary">Login</span>
          <span class="font-mono text-xs">{{ user.login }}</span>
        </div>
        <div class="flex items-center justify-between p-3">
          <span class="text-xs text-text-secondary">Email</span>
          <span class="font-mono text-xs">{{ user.email ?? '—' }}</span>
        </div>
        <div class="flex items-center justify-between p-3">
          <span class="text-xs text-text-secondary">Provider</span>
          <span class="font-mono text-xs">{{ user.provider }}</span>
        </div>
      </div>
    </section>

    <!-- Plan -->
    <section class="mb-8">
      <h2 class="mb-3 font-mono text-xs uppercase tracking-wider text-text-muted">Plan</h2>
      <div class="border border-border p-4">
        <div class="mb-4 flex items-center gap-3">
          <span class="font-mono text-sm uppercase text-accent">{{ user.plan }}</span>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="flex items-center justify-between">
            <span class="text-xs text-text-secondary">Requests/mo</span>
            <span class="font-mono text-xs">{{ formatLimit(user.limits.requestsPerMonth) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs text-text-secondary">Deploys/day</span>
            <span class="font-mono text-xs">{{ formatLimit(user.limits.deploysPerDay) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs text-text-secondary">D1 Storage</span>
            <span class="font-mono text-xs">{{ formatLimit(user.limits.d1StorageBytes) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs text-text-secondary">R2 Storage</span>
            <span class="font-mono text-xs">{{ formatLimit(user.limits.r2StorageBytes) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs text-text-secondary">KV Storage</span>
            <span class="font-mono text-xs">{{ formatLimit(user.limits.kvStorageBytes) }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs text-text-secondary">AI Neurons/mo</span>
            <span class="font-mono text-xs">
              {{ formatLimit(user.limits.aiNeuronsPerMonth) }}
            </span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
