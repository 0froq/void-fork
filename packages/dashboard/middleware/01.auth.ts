import { defineMiddleware } from "void";
import { deleteCookie, getCookie } from "hono/cookie";
import { createDb, type Db } from "@voidcloud/api/db";
import { authenticateDashboardToken } from "@voidcloud/api/auth/dashboard";

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

  // Init DB from Hyperdrive binding (available on all routes)
  const connectionString = (c.env as unknown as { HYPERDRIVE: Hyperdrive }).HYPERDRIVE
    .connectionString;
  c.set("db", createDb(connectionString));

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
  const session = await authenticateDashboardToken(
    token,
    (c.env as Record<string, string | undefined>).JWT_SECRET,
  );
  if (!session) {
    deleteCookie(c, "void_token", { path: "/" });
    c.set("shared", { user: null });
    return c.redirect("/login");
  }

  c.set("token", session.token);
  c.set("userId", session.user.id);
  c.set("shared", { user: { login: session.user.login } });

  return next();
});
