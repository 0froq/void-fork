import type { Env } from "hono";
import type { Db } from "./db";

export interface ApiEnv extends Env {
  Bindings: {
    HYPERDRIVE: Hyperdrive;
    ISR_CACHE: KVNamespace;
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
    VOID_PROXY_SERVICE?: string;
    VOID_PROXY_TOKEN?: string;
    SITE_DOMAIN?: string;
    DASHBOARD_URL?: string;
    USAGE_COUNTER: DurableObjectNamespace;
    CRON_SCHEDULER: DurableObjectNamespace;
    LOGS_DATASET?: string;
    PLATFORM_ENV?: string;
  };
  Variables: {
    userId: string;
    userLogin: string;
    db: Db;
  };
}
