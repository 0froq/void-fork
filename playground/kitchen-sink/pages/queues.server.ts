import { defineHandler, type InferProps } from "void";
import { kv } from "void/kv";
import { queues } from "void/queues";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const list = await kv.list({ prefix: "queue-result:" });
  const results = await Promise.all(
    list.keys.map(async (k) => ({
      key: k.name.slice("queue-result:".length),
      value: await kv.get(k.name),
    })),
  );
  return { results };
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{ key: string; value: string }>();
  await queues["demo-queue"].send({ key: body.key, value: body.value });
});
