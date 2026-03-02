import { getRuntimeBinding } from "./env";

export interface RevalidateOptions {
  paths?: string[];
  all?: boolean;
}

/**
 * Revalidate ISR-cached pages on demand.
 *
 * In production, calls the platform proxy via service binding which forwards
 * to the API for R2 deletion + edge cache purge. In local dev, this is a
 * no-op (no ISR cache to purge).
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
  const proxy = getRuntimeBinding<Fetcher>("__VOID_PROXY");
  if (!proxy) {
    // Local dev — no ISR cache to purge, no-op
    return;
  }

  const projectId = getRuntimeBinding<string>("__PROJECT_ID");
  const token = getRuntimeBinding<string>("__VOID_PROXY_TOKEN");

  if (!projectId || !token) {
    throw new Error("ISR revalidation requires __PROJECT_ID and __VOID_PROXY_TOKEN bindings.");
  }

  const response = await proxy.fetch("https://proxy/revalidate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, aiToken: token, ...options }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Revalidation failed (${response.status}): ${text}`);
  }
}
