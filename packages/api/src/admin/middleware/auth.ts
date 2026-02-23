import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ApiEnv } from "../../env";
import { verifyJwt } from "../../auth/jwt";
import { getUser, getFirstAdmin } from "../../db";

export const adminAuthMiddleware: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS) {
    const admin = await getFirstAdmin(c.get("db"));
    if (admin) {
      c.set("userId", admin.id);
      c.set("userLogin", admin.login);
      return next();
    }
  }

  const token = getCookie(c, "admin_token");
  if (!token) {
    return c.redirect("/admin/login");
  }

  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.redirect("/admin/login");
  }

  const user = await getUser(c.get("db"), payload.sub);
  if (!user || user.role !== "admin") {
    return c.html("<h1>403 Forbidden</h1><p>Admin access required.</p>", 403);
  }

  c.set("userId", payload.sub);
  c.set("userLogin", payload.login);
  await next();
};
