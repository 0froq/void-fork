import type { Env } from "hono";
import type { Db } from "./db";

/**
 * Returns true when DEV_AUTH_BYPASS is set and we are NOT in production.
 * Defaults to production for unknown PLATFORM_ENV values — only unset
 * (local dev) and "staging" are treated as non-production.
 */
export function isDevBypass(env: { DEV_AUTH_BYPASS?: string; PLATFORM_ENV?: string }): boolean {
  if (!env.DEV_AUTH_BYPASS) return false;
  const pe = env.PLATFORM_ENV;
  return pe === undefined || pe === "" || pe === "staging";
}

export interface ApiEnv extends Env {
  Bindings: {
    HYPERDRIVE: Hyperdrive;
    ISR_CACHE: KVNamespace;
    ROUTING: KVNamespace;
    STATIC_ASSETS: KVNamespace;
    STATIC_ASSETS_R2: R2Bucket;
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
    VOID_PROXY_SERVICE?: string;
    VOID_PROXY_TOKEN?: string;
    SITE_DOMAIN?: string;
    DASHBOARD_URL?: string;
    USAGE_COUNTER: DurableObjectNamespace;
    CRON_SCHEDULER: DurableObjectNamespace;
    LOGS_DATASET?: string;
    PLATFORM_ENV?: string;
    PROJECT_SECRET_KEYS_JSON: string;
    PROJECT_SECRET_ACTIVE_KEY_VERSION: string;
    EMAIL?: SendEmail;
  };
  Variables: {
    userId: string;
    userLogin: string;
    db: Db;
  };
}
