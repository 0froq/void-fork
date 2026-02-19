import type { Env } from "hono";

export interface PlatformEnv extends Env {
  Bindings: {
    DB: D1Database;
    ASSETS: R2Bucket;
    ROUTING: KVNamespace;
    DISPATCH: DispatchNamespace;
    CF_API_TOKEN: string;
    CF_ACCOUNT_ID: string;
    CF_ZONE_ID: string;
    JWT_SECRET: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    AUTH_REDIRECT_URI?: string;
    DEV_AUTH_BYPASS?: string;
    DISPATCH_NAMESPACE?: string;
    SITE_DOMAIN?: string;
    SIGNUP_ALLOWLIST?: string;
  };
  Variables: {
    userId: string;
    userLogin: string;
  };
}
