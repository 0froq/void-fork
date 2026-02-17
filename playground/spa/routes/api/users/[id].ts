import * as v from "valibot";
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

export const GET = defineHandler.withValidator({
  params: v.object({ id: v.string() }),
})(async (c, { params }) => {
  const user = await db.get("users", { where: { id: Number(params.id) } });

  if (!user) {
    return new Response("Not found", { status: 404 });
  }
  return user;
});
