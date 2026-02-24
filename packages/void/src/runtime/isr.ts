import { env } from "cloudflare:workers";

const PLATFORM_URL = "https://api.void.cloud";

export interface RevalidateOptions {
  paths?: string[];
  all?: boolean;
}

/**
 * Revalidate ISR-cached pages on demand.
 *
 * Requires `VOID_PROJECT_ID` and `VOID_REVALIDATE_TOKEN` env bindings.
 *
 * @example
 * ```ts
 * import { revalidate } from "void/isr";
 *
 * // Revalidate specific paths
 * await revalidate({ paths: ["/", "/blog/hello"] });
 *
 * // Revalidate all ISR pages
 * await revalidate({ all: true });
 * ```
 */
export async function revalidate(options: RevalidateOptions): Promise<void> {
  const projectId = env.VOID_PROJECT_ID;
  const token = env.VOID_REVALIDATE_TOKEN;

  if (!projectId) {
    throw new Error("VOID_PROJECT_ID env binding is not set.");
  }
  if (!token) {
    throw new Error("VOID_REVALIDATE_TOKEN env binding is not set.");
  }

  const response = await fetch(`${PLATFORM_URL}/projects/${projectId}/revalidate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Revalidation failed (${response.status}): ${text}`);
  }
}
