import { db } from "void/db";
import { kv } from "void/kv";

export default defineEventHandler(async () => {
  const result = await db.get("users");

  await kv.set("smoke", "ok");
  const kvValue = await kv.get<string>("smoke");

  return { user: result, kvValue };
});
