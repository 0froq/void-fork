/** Name of the cookie used to store the session ID. */
export const SESSION_COOKIE_NAME = "__void_session";

/** Session time-to-live in seconds (7 days). */
export const SESSION_TTL_SECONDS = 604800; // 7 days

/** Shape of the session payload stored in the AUTH_KV namespace. */
export interface SessionData {
  userId: string;
  provider: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** Unix timestamp (ms) after which the session is invalid. */
  expiresAt: number;
}

/** Generate a random session ID (UUID v4). */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Extract the session ID from a `Cookie` header string.
 * Returns `null` if the header is missing or the session cookie is absent.
 */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return rest.join("=") || null;
    }
  }
  return null;
}

/** Build a `Set-Cookie` header value that sets the session cookie. */
export function buildSetCookieHeader(sessionId: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build a `Set-Cookie` header value that clears the session cookie. */
export function buildClearCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
