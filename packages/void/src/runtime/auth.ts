import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";

/** The authenticated user stored in the session and set on context by the auth middleware. */
export interface AuthUser {
  id: string;
  /** The provider that created this account (`"email"`, `"github"`, or `"google"`). */
  provider: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

/**
 * Extract the authenticated user from the request context, or throw a 401.
 *
 * Use this in route handlers to gate access to authenticated users:
 * ```ts
 * export default defineHandler((c) => {
 *   const user = requireAuth(c);
 *   return { user };
 * });
 * ```
 *
 * @throws {HTTPException} 401 if no user session is present.
 */
export function requireAuth<E extends Env & { Variables: { user: AuthUser | null } }>(
  c: Context<E>,
): AuthUser {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}
