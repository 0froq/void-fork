import { env } from "cloudflare:workers";

const PLATFORM_URL = "https://platform.vite.cloud";

export interface RevalidateOptions {
  paths?: string[];
  all?: boolean;
}

/**
 * Revalidate ISR-cached pages on demand.
 *
 * Requires `VITE_CLOUD_PROJECT_ID` and `VITE_CLOUD_REVALIDATE_TOKEN` env bindings.
 *
 * @example
 * ```ts
 * import { revalidate } from "vite-cloud/isr";
 *
 * // Revalidate specific paths
 * await revalidate({ paths: ["/", "/blog/hello"] });
 *
 * // Revalidate all ISR pages
 * await revalidate({ all: true });
 * ```
 */
export async function revalidate(options: RevalidateOptions): Promise<void> {
  const projectId = (env as any).VITE_CLOUD_PROJECT_ID;
  const token = (env as any).VITE_CLOUD_REVALIDATE_TOKEN;

  if (!projectId) {
    throw new Error("VITE_CLOUD_PROJECT_ID env binding is not set.");
  }
  if (!token) {
    throw new Error("VITE_CLOUD_REVALIDATE_TOKEN env binding is not set.");
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
