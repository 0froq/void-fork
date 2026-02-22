import type { Context } from "hono";

const PLATFORM_API_URL = "https://platform.vite.cloud";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(c: Context, path: string, options?: RequestInit): Promise<T> {
  const token = c.get("token") as string | undefined;
  const baseUrl = (c.env as Record<string, string>).PLATFORM_API_URL ?? PLATFORM_API_URL;

  const res = await fetch(`${baseUrl}${path}`, {
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

  return res.json() as Promise<T>;
}
