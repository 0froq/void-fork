import { defineHandler } from "void";
import { setCookie } from "hono/cookie";

export const loader = defineHandler((c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.redirect("/login");
  }

  setCookie(c, "void_token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return c.redirect("/");
});
