import type { Context, Env, MiddlewareHandler } from "hono";
import type { AuthUser } from "./auth";

/**
 * Hono environment type for Vite Cloud workers.
 *
 * Includes all standard Cloudflare bindings (D1, KV, R2) and the
 * auth session KV namespace. The `Variables` bag carries the
 * authenticated user set by the auth middleware.
 */
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

/**
 * Hono {@link Context} pre-typed with {@link CloudEnv}.
 *
 * This is the type of the `c` parameter in route handlers and middleware
 * created with {@link defineHandler} and {@link defineMiddleware}.
 */
export type CloudContext = Context<CloudEnv>;

type HandlerFn = (c: CloudContext) => unknown | Promise<unknown>;

/** Pre-rendered `<head>` and `<body>` asset tags injected by the SSR build. */
export interface RenderAssetTags {
  /** Script and style tags to inject into `<head>` (e.g. CSS links). */
  head: string;
  /** Script tags to inject before `</body>` (e.g. client entry module). */
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
