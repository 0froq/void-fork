import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { AdminEnv } from "../env";
import {
  getGitHubAuthorizeUrl,
  exchangeCodeForToken,
  getGitHubUser,
} from "@vite-cloud/platform/auth/github";
import {
  getGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getGoogleUser,
} from "@vite-cloud/platform/auth/google";
import { signJwt } from "@vite-cloud/platform/auth/jwt";
import { getUserByProvider } from "@vite-cloud/platform/db";

const app = new Hono<AdminEnv>();

const DEFAULT_REDIRECT_URI = "https://admin.vite.cloud/callback";

async function hmacSignState(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacVerifyState(data: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const padded = signature.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const sigBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    sigBytes[i] = binary.charCodeAt(i);
  }
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(data));
}

// GET /login
app.get("/login", (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head><title>Admin Login - Vite Cloud</title>
<style>
body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
.card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
a { display: inline-block; margin: 0.5rem; padding: 0.75rem 1.5rem; background: #24292e; color: white; text-decoration: none; border-radius: 6px; }
a.google { background: #4285f4; }
</style>
</head>
<body>
<div class="card">
<h1>Vite Cloud Admin</h1>
<p>Sign in with your admin account</p>
<a href="/login/github">GitHub</a>
<a href="/login/google" class="google">Google</a>
</div>
</body>
</html>`);
});

// GET /login/github
app.get("/login/github", async (c) => {
  const redirectUri = c.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  const nonce = crypto.randomUUID();
  const stateData = JSON.stringify({ nonce, provider: "github" });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, c.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;
  const url = getGitHubAuthorizeUrl(c.env.GITHUB_CLIENT_ID, redirectUri, state);
  return c.redirect(url);
});

// GET /login/google
app.get("/login/google", async (c) => {
  const redirectUri = c.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  const nonce = crypto.randomUUID();
  const stateData = JSON.stringify({ nonce, provider: "google" });
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

  const { provider } = JSON.parse(atob(stateEncoded)) as {
    nonce: string;
    provider: string;
  };

  let providerId: string;
  let login: string;

  if (provider === "google") {
    const redirectUri = c.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
    const googleToken = await exchangeGoogleCode(
      c.env.GOOGLE_CLIENT_ID,
      c.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri,
    );
    const googleUser = await getGoogleUser(googleToken);
    providerId = googleUser.id;
    login = googleUser.email;
  } else {
    const ghToken = await exchangeCodeForToken(
      c.env.GITHUB_CLIENT_ID,
      c.env.GITHUB_CLIENT_SECRET,
      code,
    );
    const ghUser = await getGitHubUser(ghToken);
    providerId = String(ghUser.id);
    login = ghUser.login;
  }

  const user = await getUserByProvider(c.env.DB, provider, providerId);
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

  return c.redirect("/");
});

// GET /logout
app.get("/logout", (c) => {
  deleteCookie(c, "admin_token", { path: "/" });
  return c.redirect("/login");
});

export default app;
