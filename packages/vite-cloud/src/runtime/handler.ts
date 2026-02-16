import type { Context, Env, MiddlewareHandler } from "hono";
import type { AuthUser } from "./auth";
import { convertReturnValue } from "./response";

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
type MiddlewareFn = MiddlewareHandler<CloudEnv>;

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
 * Define a route handler, optionally composed with per-route middleware.
 *
 * Single argument: identity wrapper (backwards compatible).
 * Multiple arguments: middleware chain + final handler, composed at runtime.
 */
export function defineHandler(handler: HandlerFn): HandlerFn;
export function defineHandler(m1: MiddlewareFn, handler: HandlerFn): HandlerFn;
export function defineHandler(m1: MiddlewareFn, m2: MiddlewareFn, handler: HandlerFn): HandlerFn;
export function defineHandler(
  m1: MiddlewareFn,
  m2: MiddlewareFn,
  m3: MiddlewareFn,
  handler: HandlerFn,
): HandlerFn;
export function defineHandler(
  m1: MiddlewareFn,
  m2: MiddlewareFn,
  m3: MiddlewareFn,
  m4: MiddlewareFn,
  handler: HandlerFn,
): HandlerFn;
export function defineHandler(
  m1: MiddlewareFn,
  m2: MiddlewareFn,
  m3: MiddlewareFn,
  m4: MiddlewareFn,
  m5: MiddlewareFn,
  handler: HandlerFn,
): HandlerFn;
export function defineHandler(...args: (MiddlewareFn | HandlerFn)[]): HandlerFn {
  if (args.length === 1) {
    return args[0] as HandlerFn;
  }
  const middlewares = args.slice(0, -1) as MiddlewareFn[];
  const handler = args[args.length - 1] as HandlerFn;

  return async (c: CloudContext) => {
    let index = 0;
    const dispatch = async (): Promise<void> => {
      if (index < middlewares.length) {
        const mw = middlewares[index++];
        const res = await mw(c, dispatch);
        if (res instanceof Response) {
          c.res = res;
        }
      } else {
        c.res = convertReturnValue(await handler(c));
      }
    };
    await dispatch();
    return c.res;
  };
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
