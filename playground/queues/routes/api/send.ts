import { defineHandler } from "void";
import { queues } from "void/queues";

export const POST = defineHandler(async (c) => {
  const { key, value } = await c.req.json<{ key: string; value: string }>();
  await queues["test-queue"].send({ key, value });
  return { sent: true };
});
