import type { Context, Env, MiddlewareHandler } from "hono";

export interface CloudEnv extends Env {
  Bindings: {
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    [key: string]: unknown;
  };
}

export type CloudContext = Context<CloudEnv>;

type HandlerFn = (c: CloudContext) => unknown | Promise<unknown>;

/**
 * Identity function that provides type inference for route handlers.
 * At runtime it simply returns the function passed to it.
 */
export function defineHandler(handler: HandlerFn): HandlerFn {
  return handler;
}

/**
 * Identity function that provides type inference for middleware.
 * At runtime it simply returns the function passed to it.
 */
export function defineMiddleware(
  handler: MiddlewareHandler<CloudEnv>,
): MiddlewareHandler<CloudEnv> {
  return handler;
}
