import { defineHandler } from "void";
import { deleteCookie } from "hono/cookie";

export const loader = defineHandler((c) => {
  deleteCookie(c, "void_token", { path: "/" });
  return c.redirect("/login");
});
