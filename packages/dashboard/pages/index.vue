<script setup lang="ts">
import { Link } from "@voidcloud/vue";
import type { Props } from "./index.server";

const { projects, usage } = defineProps<Props>();

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
</script>

<template>
  <div>
    <!-- Usage summary -->
    <div class="mb-8 grid grid-cols-3 gap-4">
      <div class="border border-border p-4">
        <p class="text-xs uppercase tracking-wider text-text-muted">Requests</p>
        <p class="mt-1 font-mono text-xl">{{ formatNumber(usage.requests) }}</p>
      </div>
      <div class="border border-border p-4">
        <p class="text-xs uppercase tracking-wider text-text-muted">Bandwidth</p>
        <p class="mt-1 font-mono text-xl">{{ formatBytes(usage.bandwidthBytes) }}</p>
      </div>
      <div class="border border-border p-4">
        <p class="text-xs uppercase tracking-wider text-text-muted">AI Neurons</p>
        <p class="mt-1 font-mono text-xl">{{ formatNumber(usage.aiNeurons) }}</p>
      </div>
    </div>

    <!-- Projects -->
    <div class="mb-4 flex items-center justify-between">
      <h2 class="font-mono text-sm text-text-secondary">Projects</h2>
    </div>

    <div v-if="projects.length === 0" class="border border-border p-8 text-center">
      <p class="mb-2 text-sm text-text-secondary">No projects yet</p>
      <p class="font-mono text-xs text-text-muted">
        Run <code class="text-accent">void projects create</code> to get started
      </p>
    </div>

    <div v-else class="divide-y divide-border border border-border">
      <Link
        v-for="project in projects"
        :key="project.id"
        :href="`/projects/${project.id}`"
        class="flex items-center justify-between p-4 transition-colors hover:bg-accent-bg"
      >
        <div>
          <span class="font-mono text-sm">{{ project.slug }}</span>
          <span class="ml-3 border border-border px-1.5 py-0.5 text-xs text-text-muted">
            {{ project.mode }}
          </span>
        </div>
        <div class="flex items-center gap-4 font-mono text-xs text-text-muted">
          <span>{{ project.custom_domain ?? `${project.slug}.void.app` }}</span>
          <span>
            {{
              formatNumber(usage.projects.find((u) => u.projectId === project.id)?.requests ?? 0)
            }}
            req
          </span>
        </div>
      </Link>
    </div>
  </div>
</template>
