/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
  interface Env {
    // User-facing bindings (auto-inferred from source code)
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AI: Ai;

    // Platform-injected bindings (present when deployed on Void)
    /** @internal Service binding to proxy worker (AI, revalidation, future features) */
    __VOID_PROXY?: Fetcher;
    /** @internal Custom proxy URL override */
    __VOID_PROXY_URL?: string;
    /** @internal Auth token for HTTP proxy (local dev) */
    __VOID_TOKEN?: string;
    /** @internal Project ID for HTTP proxy (local dev) */
    __VOID_PROJECT_ID?: string;
    /** @internal Staging environment flag */
    __VOID_STAGING?: string;
    /** @internal Project ID (service binding path) */
    __PROJECT_ID?: string;
    /** @internal Proxy token (service binding path) */
    __VOID_PROXY_TOKEN?: string;

    // Queue bindings (QUEUE_<name>)
    [key: `QUEUE_${string}`]: Queue<unknown> | undefined;
  }
}
