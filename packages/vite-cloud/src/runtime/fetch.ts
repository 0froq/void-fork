import type { RouteMap } from "vite-cloud/routes";

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
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export class FetchError extends Error {
  response: Response;
  status: number;

  constructor(response: Response) {
    super(`Fetch failed with status ${response.status}`);
    this.name = "FetchError";
    this.response = response;
    this.status = response.status;
  }
}

/**
 * Typed fetch client for Vite Cloud API routes.
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
  const method = (options?.method ?? "GET") as string;

  // Interpolate :param segments
  let url = path as string;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url = url.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  // Build query string
  if (options?.query) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      searchParams.set(key, value);
    }
    const qs = searchParams.toString();
    if (qs) {
      url += `?${qs}`;
    }
  }

  const init: RequestInit = {
    method,
    headers: options?.headers,
    signal: options?.signal,
  };

  // Serialize body as JSON
  if (options?.body !== undefined && options?.body !== null) {
    init.body = JSON.stringify(options.body);
    init.headers = new Headers(init.headers);
    (init.headers as Headers).set("Content-Type", "application/json");
  }

  const response = await globalThis.fetch(url, init);

  if (!response.ok) {
    throw new FetchError(response);
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as OutputOf<P, M>;
  }

  return (await response.json()) as OutputOf<P, M>;
}
