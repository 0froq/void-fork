import { defineScheduled } from "vite-cloud";

export const cron = "0 * * * *";

export default defineScheduled(async (controller, env) => {
  await env.KV.put("jobs:last-heartbeat", controller.scheduledTime.toString());
});
