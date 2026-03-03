import { defineHandler, type InferProps } from "void";
import { db } from "void/db";
import { queues } from "void/queues";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const results = await db.list("queue_results", { orderBy: "id DESC", limit: 50 });
  return { results };
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{ intent?: string; key: string; value?: string; id?: number }>();

  if (body.intent === "delete") {
    await db.delete("queue_results", { where: { id: body.id! } });
  } else {
    await queues["demo-queue"].send({ key: body.key, value: body.value! });
  }
});
