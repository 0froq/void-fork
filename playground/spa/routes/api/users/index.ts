import * as v from "valibot";
import { defineHandler } from "vite-cloud";
import { db } from "vite-cloud/db";

export const GET = defineHandler(async () => {
  return db.list("users");
});

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})(async (c, { body }) => {
  await db.insert("users", { name: body.name, email: body.email });
  return { created: true };
});
