<script setup lang="ts">
import { useForm } from "void/vue";
import type { Props } from "./queues.server";

defineProps<Props>();

const form = useForm("/queues", {
  key: "",
  value: "",
});
</script>
<template>
  <div>
    <h1>Queues</h1>
    <p>
      Message queues via <code>void/queues</code>. Messages are sent to <code>demo-queue</code>,
      consumed and written to KV.
    </p>

    <h2>Send Message</h2>
    <form @submit.prevent="form.post()">
      <div>
        <label>Key: </label>
        <input v-model="form.data.key" placeholder="my-key" required />
      </div>
      <div style="margin-top: 5px">
        <label>Value: </label>
        <input v-model="form.data.value" placeholder="my-value" required />
      </div>
      <button type="submit" :disabled="form.processing" style="margin-top: 5px">
        {{ form.processing ? "Sending..." : "Send to Queue" }}
      </button>
    </form>

    <h2>Processed Results ({{ results.length }})</h2>
    <p>
      <em
        >Messages consumed from the queue are written to KV with prefix
        <code>queue-result:</code></em
      >
    </p>
    <ul v-if="results.length">
      <li v-for="r in results" :key="r.key">
        <code>{{ r.key }}</code> = <code>{{ r.value }}</code>
      </li>
    </ul>
    <p v-else><em>No results yet. Send a message and wait for the consumer to process it.</em></p>
  </div>
</template>
