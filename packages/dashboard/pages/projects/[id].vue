<script setup lang="ts">
import { Link, useRouter } from "@voidcloud/vue";
import type { Props } from "./[id].server";
import { ref } from "vue";

const { project, deployments, usage, domains, secrets, resources } = defineProps<Props>();

const router = useRouter();
const expandedDeploy = ref<string | null>(null);

function toggleDeploy(id: string) {
  expandedDeploy.value = expandedDeploy.value === id ? null : id;
}

const statusColor: Record<string, string> = {
  live: "text-status-live",
  pending: "text-status-pending",
  uploading: "text-status-pending",
  migrating: "text-status-pending",
  prerendering: "text-status-pending",
  failed: "text-status-failed",
};

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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const liveUrl = project.custom_domain
  ? `https://${project.custom_domain}`
  : `https://${project.slug}.vitecloud.app`;

// Domain form
const newDomain = ref("");

function addDomain() {
  const data = new FormData();
  data.set("_intent", "add-domain");
  data.set("hostname", newDomain.value);
  router.post(`/projects/${project.id}`, data);
  newDomain.value = "";
}

function removeDomain(domainId: string) {
  const data = new FormData();
  data.set("_intent", "remove-domain");
  data.set("domainId", domainId);
  router.post(`/projects/${project.id}`, data);
}

// Secret form
const newSecretName = ref("");
const newSecretValue = ref("");

function addSecret() {
  const data = new FormData();
  data.set("_intent", "add-secret");
  data.set("name", newSecretName.value);
  data.set("value", newSecretValue.value);
  router.post(`/projects/${project.id}`, data);
  newSecretName.value = "";
  newSecretValue.value = "";
}

function removeSecret(name: string) {
  const data = new FormData();
  data.set("_intent", "remove-secret");
  data.set("name", name);
  router.post(`/projects/${project.id}`, data);
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="mb-8 flex items-center justify-between">
      <div>
        <div class="flex items-center gap-3">
          <Link href="/" class="text-sm text-text-muted hover:text-text">&larr;</Link>
          <h1 class="font-mono text-lg">{{ project.slug }}</h1>
          <span class="border border-border px-1.5 py-0.5 text-xs text-text-muted">
            {{ project.mode }}
          </span>
        </div>
        <a
          :href="liveUrl"
          target="_blank"
          class="mt-1 block font-mono text-xs text-accent hover:text-accent-hover"
        >
          {{ liveUrl }}
        </a>
      </div>
    </div>

    <!-- Deployments -->
    <section class="mb-8">
      <h2 class="mb-3 font-mono text-xs uppercase tracking-wider text-text-muted">Deployments</h2>
      <div v-if="deployments.length === 0" class="border border-border p-6 text-center">
        <p class="text-sm text-text-secondary">No deployments yet</p>
      </div>
      <div v-else class="divide-y divide-border border border-border">
        <div v-for="d in deployments" :key="d.id">
          <button
            class="flex w-full items-center justify-between p-3 text-left transition-colors hover:bg-accent-bg"
            @click="d.error_message ? toggleDeploy(d.id) : undefined"
          >
            <div class="flex items-center gap-3">
              <span :class="statusColor[d.status]" class="font-mono text-xs">
                {{ d.status }}
              </span>
              <span v-if="d.commit" class="font-mono text-xs text-text-secondary">
                {{ d.commit.slice(0, 7) }}
              </span>
              <span v-if="d.source" class="text-xs text-text-muted">
                {{ d.source }}
              </span>
            </div>
            <span class="font-mono text-xs text-text-muted">
              {{ timeAgo(d.created_at) }}
            </span>
          </button>
          <div
            v-if="d.error_message && expandedDeploy === d.id"
            class="border-t border-border bg-bg-raised p-3"
          >
            <pre class="whitespace-pre-wrap font-mono text-xs text-status-failed">{{
              d.error_message
            }}</pre>
          </div>
        </div>
      </div>
    </section>

    <!-- Usage -->
    <section class="mb-8">
      <h2 class="mb-3 font-mono text-xs uppercase tracking-wider text-text-muted">
        Usage — current billing period
      </h2>
      <div class="grid grid-cols-3 gap-4">
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
    </section>

    <!-- Domains -->
    <section class="mb-8">
      <h2 class="mb-3 font-mono text-xs uppercase tracking-wider text-text-muted">Domains</h2>
      <div class="border border-border p-4">
        <div class="mb-2 flex items-center justify-between">
          <span class="font-mono text-xs text-text-secondary">
            {{ project.slug }}.vitecloud.app
          </span>
          <span class="text-xs text-status-live">default</span>
        </div>
        <div
          v-for="d in domains"
          :key="d.id"
          class="flex items-center justify-between border-t border-border py-2"
        >
          <span class="font-mono text-xs">{{ d.hostname }}</span>
          <div class="flex items-center gap-3">
            <span
              :class="d.status === 'active' ? 'text-status-live' : 'text-status-pending'"
              class="text-xs"
            >
              {{ d.status }}
            </span>
            <button
              class="text-xs text-text-muted transition-colors hover:text-status-failed"
              @click="removeDomain(d.id)"
            >
              remove
            </button>
          </div>
        </div>
        <form class="mt-3 flex gap-2" @submit.prevent="addDomain">
          <input
            v-model="newDomain"
            placeholder="example.com"
            class="flex-1 border border-border bg-bg-input px-3 py-1.5 font-mono text-xs text-text placeholder:text-text-muted focus:border-border-focus focus:outline-none"
          />
          <button
            type="submit"
            class="border border-accent bg-accent-bg px-3 py-1.5 text-xs text-accent hover:bg-accent-bg-hover"
          >
            Add domain
          </button>
        </form>
      </div>
    </section>

    <!-- Secrets -->
    <section class="mb-8">
      <h2 class="mb-3 font-mono text-xs uppercase tracking-wider text-text-muted">Secrets</h2>
      <div
        v-if="secrets.length === 0 && !newSecretName"
        class="border border-border p-6 text-center"
      >
        <p class="text-sm text-text-secondary">No secrets configured</p>
      </div>
      <div v-if="secrets.length > 0" class="divide-y divide-border border border-border">
        <div v-for="s in secrets" :key="s.name" class="flex items-center justify-between p-3">
          <span class="font-mono text-xs">{{ s.name }}</span>
          <div class="flex items-center gap-3">
            <span class="font-mono text-xs text-text-muted">••••••••</span>
            <button
              class="text-xs text-text-muted transition-colors hover:text-status-failed"
              @click="removeSecret(s.name)"
            >
              remove
            </button>
          </div>
        </div>
      </div>
      <form class="mt-3 flex gap-2" @submit.prevent="addSecret">
        <input
          v-model="newSecretName"
          placeholder="SECRET_NAME"
          class="w-40 border border-border bg-bg-input px-3 py-1.5 font-mono text-xs text-text uppercase placeholder:text-text-muted placeholder:normal-case focus:border-border-focus focus:outline-none"
        />
        <input
          v-model="newSecretValue"
          type="password"
          placeholder="value"
          class="flex-1 border border-border bg-bg-input px-3 py-1.5 font-mono text-xs text-text placeholder:text-text-muted focus:border-border-focus focus:outline-none"
        />
        <button
          type="submit"
          class="border border-accent bg-accent-bg px-3 py-1.5 text-xs text-accent hover:bg-accent-bg-hover"
        >
          Set
        </button>
      </form>
    </section>

    <!-- Resources -->
    <section v-if="resources.length > 0" class="mb-8">
      <h2 class="mb-3 font-mono text-xs uppercase tracking-wider text-text-muted">Resources</h2>
      <div class="divide-y divide-border border border-border">
        <div v-for="r in resources" :key="r.id" class="flex items-center justify-between p-3">
          <div class="flex items-center gap-3">
            <span class="border border-border px-1.5 py-0.5 text-xs uppercase text-text-muted">
              {{ r.type }}
            </span>
            <span class="font-mono text-xs">{{ r.binding_name }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
