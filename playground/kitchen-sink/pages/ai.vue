<script setup lang="ts">
import { ref } from "vue";
import type { Props } from "./ai.server";

defineProps<Props>();

const prompt = ref("");
const response = ref("");
const loading = ref(false);

async function submit() {
  if (!prompt.value.trim()) return;
  loading.value = true;
  response.value = "";

  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.value }),
    });

    if (!res.ok) {
      response.value = `Error: ${res.status} ${res.statusText}`;
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      // Parse SSE lines
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            response.value += parsed.response ?? "";
          } catch {
            // skip unparseable chunks
          }
        }
      }
    }
  } catch (err) {
    response.value = `Error: ${err}`;
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div>
    <h1>AI</h1>
    <p>
      Workers AI inference via <code>void/ai</code>. Model: <code>{{ model }}</code>
    </p>

    <h2>Prompt</h2>
    <form @submit.prevent="submit">
      <div>
        <textarea
          v-model="prompt"
          placeholder="Ask something..."
          rows="3"
          style="width: 100%; font-family: monospace"
        ></textarea>
      </div>
      <button type="submit" :disabled="loading" style="margin-top: 5px">
        {{ loading ? "Generating..." : "Send" }}
      </button>
    </form>

    <h2>Response</h2>
    <pre style="white-space: pre-wrap; background: #f5f5f5; padding: 10px; min-height: 60px">{{
      response || "(waiting for prompt...)"
    }}</pre>
  </div>
</template>
