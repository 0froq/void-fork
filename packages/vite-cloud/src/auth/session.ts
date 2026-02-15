export const SESSION_COOKIE_NAME = "__vc_session";
export const SESSION_TTL_SECONDS = 604800; // 7 days

export interface SessionData {
  userId: string;
  provider: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  createdAt: number;
  expiresAt: number;
}

export function generateSessionId(): string {
  return crypto.randomUUID();
}

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

export function buildClearCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
