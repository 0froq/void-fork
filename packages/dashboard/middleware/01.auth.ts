import { defineMiddleware } from "void";
import { getCookie } from "hono/cookie";
import { createDb, type Db } from "@voidcloud/api/db";

declare module "void" {
  interface CloudContextVariables {
    token: string;
    db: Db;
    userId: string;
    shared: { user: { login: string } | null };
  }
}

export default defineMiddleware(async (c, next) => {
  const path = c.req.path;

  // Init DB from D1 binding (available on all routes)
  const d1 = (c.env as { DB: D1Database }).DB;
  c.set("db", createDb(d1));

  // Dev bypass — skip auth entirely, platform also bypasses when DEV_AUTH_BYPASS is set
  const devBypass = (c.env as Record<string, string>).DEV_AUTH_BYPASS;
  if (devBypass) {
    c.set("token", "dev-bypass");
    c.set("userId", "user_seed1");
    c.set("shared", { user: { login: "dev" } });
    return next();
  }

  // Public routes — no auth required
  if (path === "/login" || path.startsWith("/auth/")) {
    c.set("shared", { user: null });
    return next();
  }

  const token = getCookie(c, "void_token");
  if (!token) {
    return c.redirect("/login");
  }

  c.set("token", token);

  // Decode login + userId from JWT payload
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    c.set("userId", payload.sub);
    c.set("shared", { user: { login: payload.login } });
  } catch {
    c.set("shared", { user: null });
  }

  return next();
});
