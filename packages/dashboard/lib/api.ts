import { hc, type InferResponseType } from "hono/client";
import type { ApiRoutes } from "@voidcloud/api/api";
import type { Context } from "hono";

export type Client = ReturnType<typeof hc<ApiRoutes>>;

/** Extract the 200 JSON response type from an hc client route key. */
export type API<K extends keyof B, B = Client> = InferResponseType<
  B[K] extends { $get: infer G } ? G : B[K],
  200
>;

const API_URL = "https://api.void.cloud";

/** Use service binding when available (production), fall back to HTTP (local dev). */
function getApiFetch(c: Context): typeof fetch {
  const binding = (c.env as { API?: Fetcher }).API;
  return binding ? binding.fetch.bind(binding) : globalThis.fetch;
}

export function createClient(c: Context) {
  const token = c.get("token") as string | undefined;
  const baseUrl = (c.env as Record<string, string>).API_URL ?? API_URL;
  return hc<ApiRoutes>(baseUrl, {
    fetch: getApiFetch(c),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api(c: Context, path: string, options?: RequestInit): Promise<Response> {
  const token = c.get("token") as string | undefined;
  const baseUrl = (c.env as Record<string, string>).API_URL ?? API_URL;
  const f = getApiFetch(c);

  const res = await f(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...options?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body);
  }

  return res;
}
