/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
  interface Env {
    // User-facing bindings (auto-inferred from source code)
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AI: Ai;

    // Platform-injected bindings (present when deployed on Void)
    /** @internal Service binding to ai-proxy worker */
    __AI_PROXY?: Fetcher;
    /** @internal Custom AI proxy URL override */
    __AI_PROXY_URL?: string;
    /** @internal Auth token for HTTP AI proxy */
    __VOID_TOKEN?: string;
    /** @internal Project ID for HTTP AI proxy */
    __VOID_PROJECT_ID?: string;
    /** @internal Staging environment flag */
    __VOID_STAGING?: string;
    /** @internal Project ID (service binding path) */
    __PROJECT_ID?: string;
    /** @internal AI token (service binding path) */
    __AI_TOKEN?: string;

    // ISR bindings (user-configured for on-demand revalidation)
    VOID_PROJECT_ID?: string;
    VOID_REVALIDATE_TOKEN?: string;

    // Queue bindings (QUEUE_<name>)
    [key: `QUEUE_${string}`]: Queue<unknown> | undefined;
  }
}
