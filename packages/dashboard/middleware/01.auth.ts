import { defineMiddleware } from "void";
import { getCookie } from "hono/cookie";

declare module "void" {
  interface CloudContextVariables {
    token: string;
    shared: { user: { login: string } | null };
  }
}

export default defineMiddleware(async (c, next) => {
  const path = c.req.path;

  // Dev bypass — skip auth entirely, platform also bypasses when DEV_AUTH_BYPASS is set
  const devBypass = (c.env as Record<string, string>).DEV_AUTH_BYPASS;
  if (devBypass) {
    c.set("token", "dev-bypass");
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

  // Decode login from JWT payload for nav display
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    c.set("shared", { user: { login: payload.login } });
  } catch {
    c.set("shared", { user: null });
  }

  return next();
});
