import type { MiddlewareHandler } from "hono";
import type { PlatformEnv } from "../env";
import { getUser } from "../db";

export const adminMiddleware: MiddlewareHandler<PlatformEnv> = async (c, next) => {
  const userId = c.get("userId");
  const user = await getUser(c.env.DB, userId);
  if (!user || user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
};
