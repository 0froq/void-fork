import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";

export interface AuthUser {
  id: string;
  provider: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

export function requireAuth(c: Context<Env & { Variables: { user: AuthUser | null } }>): AuthUser {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}
