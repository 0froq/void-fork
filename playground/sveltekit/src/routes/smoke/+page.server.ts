import { db } from "void/db";
import { kv } from "void/kv";

export async function load() {
  const users = await db.list("users", { limit: 1 });
  const user = users[0] ?? null;

  await kv.set("smoke", "ok");
  const kvValue = await kv.get<string>("smoke");

  return { d1User: user, kvValue };
}
