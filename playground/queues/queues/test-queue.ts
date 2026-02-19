import { defineQueue } from "vite-cloud";

export const maxBatchTimeout = 1;

export default defineQueue<{ key: string; value: string }>(async (batch, env) => {
  for (const msg of batch.messages) {
    await env.KV.put(`queue-result:${msg.body.key}`, msg.body.value);
  }
});
