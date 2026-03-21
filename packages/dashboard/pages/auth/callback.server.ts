import { defineHandler } from "void";
import { setCookie } from "hono/cookie";

export const loader = defineHandler(async (c) => {
  // Production/staging: exchange short-lived auth code for JWT via API
  const code = c.req.query("code");
  if (code) {
    const apiUrl = (c.env as Record<string, string>).API_URL ?? "https://api.void.cloud";
    const resp = await fetch(`${apiUrl}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!resp.ok) {
      return c.redirect("/login");
    }
    const { token } = (await resp.json()) as { token: string };
    setCookie(c, "void_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect("/");
  }

  // Local dev: token arrives as query param (localhost can't use code exchange)
  const token = c.req.query("token");
  if (token) {
    const isSecure = new URL(c.req.url).protocol === "https:";
    setCookie(c, "void_token", token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect("/");
  }

  return c.redirect("/login");
});
