import type { Env } from "hono";

export interface PlatformEnv extends Env {
  Bindings: {
    DB: D1Database;
    ASSETS: R2Bucket;
    ROUTING: KVNamespace;
    DISPATCH: DispatchNamespace;
    CF_API_TOKEN: string;
    CF_ACCOUNT_ID: string;
    JWT_SECRET: string;
  };
}
