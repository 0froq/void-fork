import { ofetch, FetchError } from "ofetch";
import type { RouteMap } from "vite-cloud/routes";

export { FetchError };

type MethodsOf<P extends keyof RouteMap> = keyof RouteMap[P] & string;
type DefaultMethod<P extends keyof RouteMap> = "GET" extends MethodsOf<P> ? "GET" : never;

type RouteEntry<P extends keyof RouteMap, M extends MethodsOf<P>> = RouteMap[P][M] extends {
  input: infer I;
  output: infer O;
}
  ? { input: I; output: O }
  : { input: {}; output: unknown };

type OutputOf<P extends keyof RouteMap, M extends MethodsOf<P>> = RouteEntry<P, M>["output"];

interface FetchOptionsBase<P extends keyof RouteMap, M extends MethodsOf<P>> {
  method?: M;
  body?: Record<string, any> | BodyInit | null;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: HeadersInit;
  signal?: AbortSignal;
  baseURL?: string;
  retry?: number;
  timeout?: number;
}

/**
 * Typed fetch client for Vite Cloud API routes.
 *
 * Built on top of ofetch. Supports baseURL, retry, timeout, and all
 * ofetch features while providing full route type safety.
 *
 * ```ts
 * import { fetch } from "vite-cloud/client";
 *
 * const users = await fetch("/api/users"); // typed!
 * const user = await fetch("/api/users/:id", { params: { id: "1" } });
 * ```
 */
export async function fetch<
  P extends keyof RouteMap & string,
  M extends MethodsOf<P> = DefaultMethod<P>,
>(path: P, options?: FetchOptionsBase<P, M>): Promise<OutputOf<P, M>> {
  // Interpolate :param segments
  let url = path as string;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url = url.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  return ofetch(url, {
    method: (options?.method ?? "GET") as string,
    body: options?.body,
    query: options?.query,
    headers: options?.headers,
    signal: options?.signal,
    baseURL: options?.baseURL,
    retry: options?.retry,
    timeout: options?.timeout,
  });
}
