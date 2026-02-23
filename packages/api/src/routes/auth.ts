import { Hono } from "hono";
import type { ApiEnv } from "../env";
import { getGitHubAuthorizeUrl, exchangeCodeForToken, getGitHubUser } from "../auth/github";
import {
  getGoogleAuthorizeUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getGoogleUser,
} from "../auth/google";
import { signJwt } from "../auth/jwt";
import { hmacSignState, hmacVerifyState } from "../auth/hmac";
import { getUserByProvider, getUserByEmail, createUser, updateUser } from "../db";

const DEFAULT_REDIRECT_URI = "https://api.void.cloud/auth/callback";

const app = new Hono<ApiEnv>();

function isAllowedRedirect(url: string, dashboardUrl?: string): boolean {
  if (url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:")) {
    return true;
  }
  const origin = dashboardUrl ?? "https://dash.void.cloud";
  if (url.startsWith(origin)) {
    return true;
  }
  return false;
}

// GET /auth/login?redirect=http://localhost:PORT/callback&provider=github|google
app.get("/login", async (c) => {
  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "redirect parameter is required" }, 400);
  }

  if (!isAllowedRedirect(redirect, c.env.DASHBOARD_URL)) {
    return c.json({ error: "redirect must be a localhost or dashboard URL" }, 400);
  }

  const provider = c.req.query("provider") ?? "github";
  if (provider !== "github" && provider !== "google") {
    return c.json({ error: "provider must be github or google" }, 400);
  }

  const nonce = crypto.randomUUID();
  const stateData = JSON.stringify({ redirect, nonce, provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, c.env.JWT_SECRET);
  const state = `${stateEncoded}.${signature}`;

  const redirectUri = c.env.AUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  if (provider === "google") {
    const url = getGoogleAuthorizeUrl(c.env.GOOGLE_CLIENT_ID, redirectUri, state);
    return c.redirect(url);
  }

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

  const { redirect, provider } = JSON.parse(atob(stateEncoded)) as {
    redirect: string;
    nonce: string;
    provider?: string;
  };

  // Re-validate redirect after decoding
  if (!isAllowedRedirect(redirect, c.env.DASHBOARD_URL)) {
    return c.json({ error: "invalid redirect" }, 400);
  }

  const resolvedProvider = provider ?? "github";
  let providerId: string;
  let login: string;
  let email: string | null;

  if (resolvedProvider === "google") {
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
    email = googleUser.email;
  } else {
    const ghToken = await exchangeCodeForToken(
      c.env.GITHUB_CLIENT_ID,
      c.env.GITHUB_CLIENT_SECRET,
      code,
    );
    const ghUser = await getGitHubUser(ghToken);
    providerId = String(ghUser.id);
    login = ghUser.login;
    email = ghUser.email;
  }

  // Upsert user
  let user = await getUserByProvider(c.get("db"), resolvedProvider, providerId);
  if (user) {
    await updateUser(c.get("db"), user.id, login, email);
  } else {
    // Check for duplicate email across providers
    if (email) {
      const existing = await getUserByEmail(c.get("db"), email);
      if (existing) {
        const redirectUrl = new URL(redirect);
        redirectUrl.searchParams.set("error", "email_conflict");
        redirectUrl.searchParams.set("existing_provider", existing.provider);
        return c.redirect(redirectUrl.toString());
      }
    }
    // Check signup allowlist (Google only, new users only)
    if (resolvedProvider === "google" && c.env.SIGNUP_ALLOWLIST) {
      if (!isEmailAllowed(email, c.env.SIGNUP_ALLOWLIST)) {
        const redirectUrl = new URL(redirect);
        redirectUrl.searchParams.set("error", "signup_restricted");
        return c.redirect(redirectUrl.toString());
      }
    }
    user = await createUser(c.get("db"), resolvedProvider, providerId, login, email);
  }

  // Sign JWT
  const jwt = await signJwt({ sub: user.id, login }, c.env.JWT_SECRET);

  // Redirect back to CLI
  const redirectUrl = new URL(redirect);
  redirectUrl.searchParams.set("token", jwt);
  return c.redirect(redirectUrl.toString());
});

export function isEmailAllowed(email: string | null, allowlist: string): boolean {
  if (!email) return false;
  const entries = allowlist
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const domain = "@" + email.split("@")[1];
  return entries.some((entry) =>
    entry.startsWith("@")
      ? entry.toLowerCase() === domain.toLowerCase()
      : entry.toLowerCase() === email.toLowerCase(),
  );
}

export default app;
