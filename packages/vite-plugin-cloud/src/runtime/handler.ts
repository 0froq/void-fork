import type { RequestContext } from "./context";

type HandlerFn = (ctx: RequestContext) => unknown | Promise<unknown>;

/**
 * Identity function that provides type inference for route handlers.
 * At runtime it simply returns the function passed to it.
 */
export function defineHandler(handler: HandlerFn): HandlerFn {
  return handler;
}
