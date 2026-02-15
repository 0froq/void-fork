import type { Context, Env, MiddlewareHandler } from "hono";
import type { AuthUser } from "./auth";

export interface CloudEnv extends Env {
  Bindings: {
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AUTH_KV: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    user: AuthUser | null;
  };
}

export type CloudContext = Context<CloudEnv>;

type HandlerFn = (c: CloudContext) => unknown | Promise<unknown>;
export interface RenderAssetTags {
  head: string;
  body: string;
}
type RenderFn = (c: CloudContext, assetTags: RenderAssetTags) => Response | Promise<Response>;
type JobController = ScheduledController;
type JobExecutionContext = ExecutionContext;
type JobFn = (
  controller: JobController,
  env: CloudEnv["Bindings"],
  ctx: JobExecutionContext,
) => unknown | Promise<unknown>;

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

/**
 * Identity function that provides type inference for scheduled jobs.
 * At runtime it simply returns the function passed to it.
 */
export function defineJob(handler: JobFn): JobFn {
  return handler;
}

/**
 * Identity function that provides type inference for SSR render entry.
 * The second argument includes asset tags for client scripts/styles.
 */
export function defineRender(handler: RenderFn): RenderFn {
  return handler;
}
