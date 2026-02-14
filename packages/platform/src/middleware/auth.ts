import type { MiddlewareHandler } from "hono";
import type { PlatformEnv } from "../env";
import { verifyJwt } from "../auth/jwt";

export const authMiddleware: MiddlewareHandler<PlatformEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = header.slice(7);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "invalid or expired token" }, 401);
  }

  c.set("userId", payload.sub);
  c.set("userLogin", payload.login);
  await next();
};
