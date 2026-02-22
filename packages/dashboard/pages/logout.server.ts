import { defineHandler } from "vite-cloud";
import { deleteCookie } from "hono/cookie";

export const loader = defineHandler((c) => {
  deleteCookie(c, "vc_token", { path: "/" });
  return c.redirect("/login");
});
