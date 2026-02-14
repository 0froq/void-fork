export interface RequestContext {
  /** The incoming Web Request */
  request: Request;
  /** Route params extracted from the URL pattern (e.g. { id: "123" }) */
  params: Record<string, string>;
  /** Mutable context object — middleware can attach data here */
  context: Record<string, unknown>;
  /** Cloudflare bindings mapped to user-friendly names */
  env: {
    db: D1Database;
    kv: KVNamespace;
    storage: R2Bucket;
    [key: string]: unknown;
  };
}

/**
 * Binding name mapping: Worker env binding names → user-friendly names.
 * The Cloudflare plugin uses uppercase names (DB, KV, STORAGE);
 * we expose them as lowercase (db, kv, storage).
 */
const BINDING_MAP: Record<string, string> = {
  DB: "db",
  KV: "kv",
  STORAGE: "storage",
};

/**
 * Create a RequestContext from the raw Worker arguments.
 */
export function createRequestContext(
  request: Request,
  rawEnv: Record<string, unknown>,
  params: Record<string, string>,
): RequestContext {
  // Map raw env bindings to user-friendly names
  const env: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    const mapped = BINDING_MAP[key];
    if (mapped) {
      env[mapped] = value;
    }
    // Always keep original key available too
    env[key] = value;
  }

  return {
    request,
    params,
    context: {},
    env: env as RequestContext["env"],
  };
}
