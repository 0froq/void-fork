import type { AuthUser } from "./auth";

/**
 * Error thrown by auth client helpers on non-success responses.
 */
export class AuthError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    const msg =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as Record<string, unknown>).error)
        : `Auth request failed (${status})`;
    super(msg);
    this.name = "AuthError";
    this.status = status;
    this.data = data;
  }
}

async function authRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await globalThis.fetch(path, options);
  const data = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : undefined;
  if (!res.ok) throw new AuthError(res.status, data);
  return data as T;
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Client-side auth helpers for Void's built-in authentication.
 *
 * ```ts
 * import { auth } from "void/client";
 *
 * const user = await auth.login({ email: "alice@example.com", password: "s3cret" });
 * ```
 */
export const auth = {
  /** Create a new email/password account. Sets the session cookie on success. */
  register(input: { email: string; password: string; name?: string }): Promise<AuthUser> {
    return authRequest<AuthUser>("/auth/register", jsonBody(input));
  },

  /** Sign in with email and password. Sets the session cookie on success. */
  login(input: { email: string; password: string }): Promise<AuthUser> {
    return authRequest<AuthUser>("/auth/login", jsonBody(input));
  },

  /** Return the current user, or `null` if not authenticated. */
  async me(): Promise<AuthUser | null> {
    const res = await globalThis.fetch("/auth/me");
    if (!res.ok) return null;
    return res.json();
  },

  /** Sign out and clear the session cookie. */
  logout(): Promise<void> {
    return authRequest<void>("/auth/logout", { method: "POST" });
  },
};
