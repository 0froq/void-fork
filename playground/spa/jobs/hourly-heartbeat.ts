import { defineJob } from "vite-cloud";

export const cron = "0 * * * *";

export default defineJob(async (controller, env) => {
  await env.KV.put("jobs:last-heartbeat", controller.scheduledTime.toString());
});
