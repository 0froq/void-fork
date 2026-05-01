import type { ApiRoutes } from '@voidcloud/api/api';
import type { Context } from 'hono';
import { hc, type InferResponseType } from 'hono/client';

export type Client = ReturnType<typeof hc<ApiRoutes>>;

/** Extract the 200 JSON response type from an hc client route key. */
export type API<K extends keyof B, B = Client> = InferResponseType<
  B[K] extends { $get: infer G } ? G : B[K],
  200
>;

const API_URL = 'https://api.void.cloud';

function getApiUrl(c: Context): string {
  return (c.env as Record<string, string | undefined>).API_URL ?? API_URL;
}

function isLocalHost(c: Context): boolean {
  const host = c.req.header('host') ?? '';
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

/**
 * Use service binding in deployed dashboard workers. In local dev, always use
 * HTTP so production-backed dashboard testing cannot accidentally route to a
 * local or unresolved service binding.
 */
function getApiFetch(c: Context): typeof fetch {
  const binding = (c.env as { API?: Fetcher }).API;
  if (binding && !isLocalHost(c)) {
    return binding.fetch.bind(binding);
  }
  return globalThis.fetch;
}

function getToken(c: Context): string | undefined {
  return c.get('token') as string | undefined;
}

function getHeaders(c: Context, headers?: HeadersInit): Headers {
  const out = new Headers(headers);
  const token = getToken(c);
  if (token) {
    out.set('Authorization', `Bearer ${token}`);
  }
  return out;
}

export function getPublicApiUrl(c: Context): string {
  return getApiUrl(c);
}

export function getApiOrigin(c: Context): string {
  return new URL(getApiUrl(c)).origin;
}

export function getApiClientFetch(c: Context): typeof fetch {
  return getApiFetch(c);
}

export async function fetchApi(c: Context, path: string, options?: RequestInit): Promise<Response> {
  const headers = getHeaders(c, options?.headers);
  if (options?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return getApiFetch(c)(`${getApiUrl(c)}${path}`, {
    ...options,
    headers,
  });
}

/** Use service binding when available (production), fall back to HTTP (local dev). */
export function createClient(c: Context) {
  const token = getToken(c);
  const baseUrl = getApiUrl(c);
  return hc<ApiRoutes>(baseUrl, {
    fetch: getApiFetch(c),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function getApiErrorMessage(res: Response): Promise<string> {
  const body = await res.text();
  if (!body) {
    return `${res.status} ${res.statusText}`;
  }

  try {
    const json = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof json.error === 'string') {
      return json.error;
    }
    if (typeof json.message === 'string') {
      return json.message;
    }
  } catch {
    // Plain text error body.
  }

  return body;
}

export async function getCurrentUser(c: Context): Promise<API<'me'> | null> {
  let res: Response;
  try {
    res = await fetchApi(c, '/me');
  } catch (error) {
    console.warn(
      `[dashboard] /me request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (!res.ok) {
    console.warn(`[dashboard] /me returned ${res.status}: ${await getApiErrorMessage(res)}`);
    return null;
  }
  return (await res.json()) as API<'me'>;
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
  const res = await fetchApi(c, path, options);
  if (!res.ok) {
    throw new ApiError(res.status, await getApiErrorMessage(res));
  }
  return res;
}
