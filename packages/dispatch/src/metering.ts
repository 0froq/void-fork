import type { Env } from './env.ts';

export type RequestType = 'api' | 'static' | 'ssr' | 'isr' | 'websocket';
export type FailureKind =
  | 'platform-static-asset-timeout'
  | 'platform-static-asset-error'
  | 'platform-static-asset-missing';

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
    failureKind?: FailureKind;
  },
): void {
  env.ANALYTICS.writeDataPoint({
    indexes: [data.projectId],
    blobs: [
      data.projectId,
      data.type,
      data.method,
      String(data.status),
      data.slug,
      data.failureKind ?? '',
    ],
    doubles: [1, data.responseBytes, data.durationMs],
  });
}

export async function sendUsageEvent(
  env: Env,
  data: {
    projectId: string;
    userId: string;
    slug: string;
    requests: number;
    responseBytes: number;
    status?: number;
    failureKind?: FailureKind;
  },
): Promise<void> {
  await env.USAGE_QUEUE.send(data);
}
