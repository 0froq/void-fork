import { defineMiddleware } from "vite-cloud";
import { getCookie } from "hono/cookie";

declare module "vite-cloud" {
  interface CloudContextVariables {
    token: string;
    shared: { user: { login: string } | null };
  }
}

export default defineMiddleware(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // Public routes — no auth required
  if (path === "/login" || path.startsWith("/auth/")) {
    c.set("shared", { user: null });
    return next();
  }

  const token = getCookie(c, "vc_token");
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
