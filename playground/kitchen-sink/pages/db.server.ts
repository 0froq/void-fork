import { defineHandler, type InferProps } from "void";
import { db } from "void/db";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const notes = await db.list("notes", { orderBy: "id DESC" });
  return { notes };
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{ intent: string; title?: string; body?: string; id?: number }>();

  if (body.intent === "create") {
    await db.insert("notes", { title: body.title!, body: body.body ?? "" });
  } else if (body.intent === "delete") {
    await db.delete("notes", { where: { id: body.id! } });
  }
});
