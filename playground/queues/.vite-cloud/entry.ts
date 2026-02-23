import app, { scheduled } from "virtual:void-routes";

async function queue(batch, env, ctx) {
  const messages = [...batch.messages].map((m) => ({
    id: m.id,
    timestamp: m.timestamp.toISOString(),
    body: m.body,
    attempts: m.attempts,
  }));
  const req = new Request("https://localhost/__queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queue: batch.queue, messages }),
  });
  await app.fetch(req, env, ctx);
}

export default { fetch: app.fetch, scheduled, queue };
