import type { Env } from "hono";
import type { Db } from "./db";

export interface ApiEnv extends Env {
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
    DISPATCH_WORKER_NAME?: string;
    AI_PROXY_SERVICE?: string;
    SITE_DOMAIN?: string;
    DASHBOARD_URL?: string;
    SIGNUP_ALLOWLIST?: string;
    USAGE_COUNTER: DurableObjectNamespace;
  };
  Variables: {
    userId: string;
    userLogin: string;
    db: Db;
  };
}
