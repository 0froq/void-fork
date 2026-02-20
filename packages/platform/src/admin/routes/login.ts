import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { PlatformEnv } from "../../env";
import { getGoogleAuthorizeUrl, exchangeCodeForToken, getGoogleUser } from "../../auth/google";
import { signJwt } from "../../auth/jwt";
import { hmacSignState, hmacVerifyState } from "../../auth/hmac";
import { getUserByProvider, getUserByEmail, updateUserProviderId } from "../../db";

const app = new Hono<PlatformEnv>();

// GET /login
app.get("/login", (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head><title>Admin Login - Vite Cloud</title>
<style>
body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
.card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
a { display: inline-block; margin: 0.5rem; padding: 0.75rem 1.5rem; background: #4285f4; color: white; text-decoration: none; border-radius: 6px; }
</style>
</head>
<body>
<div class="card">
<h1>Vite Cloud Admin</h1>
<p>Sign in with your admin account</p>
<a href="/admin/login/google">Google</a>
</div>
</body>
</html>`);
});

// GET /login/google
app.get("/login/google", async (c) => {
  const redirectUri = new URL(c.req.url).origin + "/admin/callback";
  const nonce = crypto.randomUUID();
  const stateData = JSON.stringify({ nonce });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, c.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;
  const url = getGoogleAuthorizeUrl(c.env.GOOGLE_CLIENT_ID, redirectUri, state);
  return c.redirect(url);
});

// GET /callback
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.html("<h1>Login failed</h1><p>Missing code or state.</p>", 400);
  }

  const dotIndex = state.lastIndexOf(".");
  if (dotIndex === -1) {
    return c.html("<h1>Login failed</h1><p>Invalid state.</p>", 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, c.env.JWT_SECRET);
  if (!valid) {
    return c.html("<h1>Login failed</h1><p>Invalid state signature.</p>", 400);
  }

  const redirectUri = new URL(c.req.url).origin + "/admin/callback";
  const googleToken = await exchangeCodeForToken(
    c.env.GOOGLE_CLIENT_ID,
    c.env.GOOGLE_CLIENT_SECRET,
    code,
    redirectUri,
  );
  const googleUser = await getGoogleUser(googleToken);
  const providerId = googleUser.id;
  const login = googleUser.email;

  let user = await getUserByProvider(c.get("db"), "google", providerId);

  // Fall back to email lookup — handles first login after seeding by email
  if (!user) {
    const byEmail = await getUserByEmail(c.get("db"), login);
    if (byEmail && byEmail.provider === "google") {
      // Backfill the real provider_id so future logins match directly
      await updateUserProviderId(c.get("db"), byEmail.id, providerId);
      user = byEmail;
    }
  }

  if (!user || user.role !== "admin") {
    return c.html(
      "<h1>403 Forbidden</h1><p>Admin access required. You must have an admin account to sign in.</p>",
      403,
    );
  }

  const jwt = await signJwt({ sub: user.id, login }, c.env.JWT_SECRET);

  setCookie(c, "admin_token", jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return c.redirect("/admin/");
});

// GET /logout
app.get("/logout", (c) => {
  deleteCookie(c, "admin_token", { path: "/" });
  return c.redirect("/admin/login");
});

export default app;
