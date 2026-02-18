import type { Env } from "hono";

export interface AdminEnv extends Env {
  Bindings: {
    DB: D1Database;
    ROUTING: KVNamespace;
    JWT_SECRET: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    AUTH_REDIRECT_URI?: string;
  };
  Variables: {
    userId: string;
    userLogin: string;
  };
}
