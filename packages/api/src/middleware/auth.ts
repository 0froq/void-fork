import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../env";
import { verifyJwt } from "../auth/jwt";
import { users } from "../schema";

export const authMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS) {
    const first = await c
      .get("db")
      .select({ id: users.id, login: users.login })
      .from(users)
      .limit(1)
      .then((r) => r[0]);
    if (first) {
      c.set("userId", first.id);
      c.set("userLogin", first.login);
      return next();
    }
  }

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
