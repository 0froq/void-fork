import type { Env } from "./env";

export type RequestType = "api" | "static" | "ssr" | "isr";

export function recordRequest(
  env: Env,
  data: {
    projectId: string;
    type: RequestType;
    method: string;
    status: number;
    responseBytes: number;
    durationMs: number;
    slug: string;
  },
): void {
  env.ANALYTICS.writeDataPoint({
    indexes: [data.projectId],
    blobs: [data.projectId, data.type, data.method, String(data.status), data.slug],
    doubles: [1, data.responseBytes, data.durationMs],
  });
}

export function sendUsageEvent(
  env: Env,
  data: {
    projectId: string;
    userId: string;
    slug: string;
    requests: number;
    responseBytes: number;
  },
): Promise<void> {
  return env.USAGE_QUEUE.send(data);
}
