import { defineHandler } from "void";
import { setCookie } from "hono/cookie";

export interface Props {
  githubUrl: string;
  googleUrl: string;
}

export const loader = defineHandler<Props>((c) => {
  const platformUrl = (c.env as Record<string, string>).API_URL ?? "https://api.void.cloud";

  // Derive origin from Host header — c.req.url can be localhost in prod
  // due to Workers Assets internal dispatch
  const host = c.req.header("host")!;
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const callbackUrl = `${protocol}://${host}/auth/callback`;

  // Bind the OAuth callback to this browser session to prevent login CSRF.
  // The nonce is included in both a cookie and the redirect URL. The callback
  // verifies the cookie value matches the URL param — an attacker's crafted
  // callback URL won't match the victim's cookie.
  const nonce = crypto.randomUUID();
  setCookie(c, "void_auth_nonce", nonce, {
    httpOnly: true,
    secure: protocol === "https",
    sameSite: "Lax",
    path: "/auth",
    maxAge: 300,
  });

  const callbackWithNonce = `${callbackUrl}?login_nonce=${nonce}`;
  const githubUrl = `${platformUrl}/auth/login?provider=github&redirect=${encodeURIComponent(callbackWithNonce)}`;
  const googleUrl = `${platformUrl}/auth/login?provider=google&redirect=${encodeURIComponent(callbackWithNonce)}`;

  return { githubUrl, googleUrl };
});
