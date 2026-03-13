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
import {
  getUserByOAuthAccount,
  getUserByEmail,
  createUser,
  updateUser,
  createOAuthAccount,
  acceptInvitationByEmail,
} from "../db";
import { isSignupAllowed, getAllowlist } from "../signup-allowlist";

const DEFAULT_REDIRECT_URI = "https://api.void.cloud/auth/callback";

const app = new Hono<ApiEnv>();

export function isAllowedRedirect(url: string, dashboardUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Localhost: allow any port, require exact hostname and http protocol
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return true;
  }

  // Dashboard: compare exact origin (protocol + hostname + port)
  const origin = dashboardUrl ?? "https://dash.void.cloud";
  try {
    return parsed.origin === new URL(origin).origin;
  } catch {
    return false;
  }
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
  let emailVerified: boolean;

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
    emailVerified = googleUser.emailVerified;
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
    emailVerified = ghUser.emailVerified;
  }

  // Upsert user — check oauth_accounts first, then email, then create
  const db = c.get("db");
  let user = await getUserByOAuthAccount(db, resolvedProvider, providerId);
  if (user) {
    // Only update login/email when the provider matches the user's primary provider
    // (avoids overwriting GitHub username with Google email)
    if (user.provider === resolvedProvider) {
      // Only overwrite stored email when the new one is verified;
      // a transient /user/emails failure must not wipe the existing email.
      if (emailVerified) {
        await updateUser(db, user.id, login, email);
      } else {
        await updateUser(db, user.id, login, user.email);
      }
    }
  } else if (email && emailVerified) {
    // Link new provider to existing account with the same email
    const existing = await getUserByEmail(db, email);
    if (existing) {
      await createOAuthAccount(db, existing.id, resolvedProvider, providerId);
      user = existing;
    }
  }

  if (!user) {
    // Check signup allowlist (new users only)
    const enabled = await c.env.ROUTING.get("signup:enabled");
    if (enabled === "true") {
      const entries = await getAllowlist(c.env.ROUTING);
      if (!isSignupAllowed(resolvedProvider, login, emailVerified ? email : null, entries)) {
        return c.redirect("/signup-restricted");
      }
    }
    user = await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      const newUser = await createUser(
        txDb,
        resolvedProvider,
        providerId,
        login,
        emailVerified ? email : null,
      );
      await createOAuthAccount(txDb, newUser.id, resolvedProvider, providerId);
      return newUser;
    });
    if (emailVerified && email) {
      try {
        await acceptInvitationByEmail(db, email, user.id);
      } catch (err) {
        console.error(`Failed to accept invitation for ${email} (user ${user.id}):`, err);
      }
    }
  }

  // Sign JWT
  const jwt = await signJwt({ sub: user.id, login }, c.env.JWT_SECRET);

  // Redirect back to CLI
  const redirectUrl = new URL(redirect);
  redirectUrl.searchParams.set("token", jwt);
  return c.redirect(redirectUrl.toString());
});

export default app;
