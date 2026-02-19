import { defineHandler } from "vite-cloud";
import { queues } from "vite-cloud/queues";

export const POST = defineHandler(async (c) => {
  const { key, value } = await c.req.json<{ key: string; value: string }>();
  await queues["test-queue"].send({ key, value });
  return { sent: true };
});
