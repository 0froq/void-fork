import type { Env } from 'hono';
import type { Db } from './db.ts';
import type { User } from './types.ts';

/**
 * Returns true when DEV_AUTH_BYPASS is set and we are NOT in production.
 * Defaults to production for unknown PLATFORM_ENV values — only unset
 * (local dev) and "staging" are treated as non-production.
 */
export function isDevBypass(env: { DEV_AUTH_BYPASS?: string; PLATFORM_ENV?: string }): boolean {
  if (!env.DEV_AUTH_BYPASS) {
    return false;
  }
  const pe = env.PLATFORM_ENV;
  return pe === undefined || pe === '' || pe === 'staging';
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
    GITHUB_PREVIEW_REPO_PAT?: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    AUTH_REDIRECT_URI?: string;
    DEV_AUTH_BYPASS?: string;
    DISPATCH_NAMESPACE?: string;
    DISPATCH_WORKER_NAME?: string;
    /**
     * Name of the tail-consumer Worker that receives runtime logs (Tail Worker).
     * Wired into per-user-script `tail_consumers` metadata on each WfP upload
     * so user scripts have explicit, belt-and-suspenders log fan-out in
     * addition to the dispatch worker's namespace-wide propagation.
     * Falls back to `void-tail` when unset.
     */
    TAIL_SERVICE_NAME?: string;
    VOID_PROXY_SERVICE?: string;
    VOID_PROXY_TOKEN?: string;
    SITE_DOMAIN?: string;
    DASHBOARD_URL?: string;
    USAGE_COUNTER: DurableObjectNamespace;
    CRON_SCHEDULER: DurableObjectNamespace;
    ERROR_ALERT_MONITOR: DurableObjectNamespace;
    /**
     * Producer for the cron-firing queue. Used by `CronScheduler.alarm()` to
     * enqueue user-worker invocations from inside its Durable Object context.
     * The queue handler in `cron-fires-queue.ts` is what actually calls
     * `env.DISPATCH.get(...).fetch(...)` — see the comment in that file for
     * why the DO can't make the call directly.
     */
    CRON_FIRES_QUEUE: Queue<import('./cron-fires-queue.ts').CronFireMessage>;
    LOGS_DATASET?: string;
    REQUESTS_DATASET?: string;
    PLATFORM_ENV?: string;
    PROJECT_SECRET_KEYS_JSON: string;
    PROJECT_SECRET_ACTIVE_KEY_VERSION: string;
    EMAIL?: SendEmail;
    /**
     * Test-only override for the deploy handler's heartbeat interval in ms.
     * Falls back to 15_000 when undefined, falsy, or non-positive. Kept on
     * `ApiEnv` (rather than wiring a fresh plumbing path) so integration tests
     * can exercise the heartbeat timer without waiting 15 seconds per case.
     */
    DEPLOY_HEARTBEAT_INTERVAL_MS?: number;
  };
  Variables: {
    user: User;
    db: Db;
  };
}
