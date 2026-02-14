import { Hono } from "hono";
import type { PlatformEnv } from "../env";
import { getGitHubAuthorizeUrl, exchangeCodeForToken, getGitHubUser } from "../auth/github";
import { signJwt } from "../auth/jwt";
import { getUserByGithubId, createUser, updateUser } from "../db";

const DEFAULT_REDIRECT_URI = "https://api.vite.cloud/auth/callback";

const app = new Hono<PlatformEnv>();

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

// GET /auth/login?redirect=http://localhost:PORT/callback
app.get("/login", async (c) => {
  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "redirect parameter is required" }, 400);
  }

  // Security: only allow localhost redirects
  if (!redirect.startsWith("http://localhost:") && !redirect.startsWith("http://127.0.0.1:")) {
    return c.json({ error: "redirect must be a localhost URL" }, 400);
  }

  const nonce = crypto.randomUUID();
  const stateData = JSON.stringify({ redirect, nonce });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, c.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;

  const redirectUri = c.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  const url = getGitHubAuthorizeUrl(c.env.GITHUB_CLIENT_ID, redirectUri, state);
  return c.redirect(url);
});

// GET /auth/callback?code=...&state=...
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "missing code or state" }, 400);
  }

  // Verify state HMAC
  const dotIndex = state.lastIndexOf(".");
  if (dotIndex === -1) {
    return c.json({ error: "invalid state" }, 400);
  }

  const stateEncoded = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);

  const valid = await hmacVerifyState(stateEncoded, signature, c.env.JWT_SECRET);
  if (!valid) {
    return c.json({ error: "invalid state signature" }, 400);
  }

  const { redirect } = JSON.parse(atob(stateEncoded)) as { redirect: string; nonce: string };

  // Re-validate redirect after decoding
  if (!redirect.startsWith("http://localhost:") && !redirect.startsWith("http://127.0.0.1:")) {
    return c.json({ error: "invalid redirect" }, 400);
  }

  // Exchange code for GitHub token
  const ghToken = await exchangeCodeForToken(
    c.env.GITHUB_CLIENT_ID,
    c.env.GITHUB_CLIENT_SECRET,
    code,
  );
  const ghUser = await getGitHubUser(ghToken);

  // Upsert user
  let user = await getUserByGithubId(c.env.DB, ghUser.id);
  if (user) {
    await updateUser(c.env.DB, user.id, ghUser.login, ghUser.email);
  } else {
    user = await createUser(c.env.DB, ghUser.id, ghUser.login, ghUser.email);
  }

  // Sign JWT
  const jwt = await signJwt({ sub: user.id, login: ghUser.login }, c.env.JWT_SECRET);

  // Redirect back to CLI
  const redirectUrl = new URL(redirect);
  redirectUrl.searchParams.set("token", jwt);
  return c.redirect(redirectUrl.toString());
});

export default app;
