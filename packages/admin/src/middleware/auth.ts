import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AdminEnv } from "../env";
import { verifyJwt } from "@vite-cloud/platform/auth/jwt";
import { getUser } from "@vite-cloud/platform/db";

export const adminAuthMiddleware: MiddlewareHandler<AdminEnv> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS) {
    const admin = await c.env.DB.prepare(
      "SELECT id, login FROM users WHERE role = 'admin' LIMIT 1",
    ).first<{ id: string; login: string }>();
    if (admin) {
      c.set("userId", admin.id);
      c.set("userLogin", admin.login);
      return next();
    }
  }

  const token = getCookie(c, "admin_token");
  if (!token) {
    return c.redirect("/login");
  }

  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.redirect("/login");
  }

  const user = await getUser(c.env.DB, payload.sub);
  if (!user || user.role !== "admin") {
    return c.html("<h1>403 Forbidden</h1><p>Admin access required.</p>", 403);
  }

  c.set("userId", payload.sub);
  c.set("userLogin", payload.login);
  await next();
};
