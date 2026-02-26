import type { Env } from "./env";
import { extractSlug } from "./hostname";
import {
  readIsrCache,
  writeIsrCache,
  deleteIsrCache,
  isStale,
  isrCacheResponse,
  resolveRevalidateTtl,
  resolvePathTtl,
  shouldBypassIsr,
} from "./isr";
import { recordRequest, sendUsageEvent, type RequestType } from "./metering";

interface RoutingEntry {
  workerName: string;
  projectId: string;
  userId?: string;
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
}

interface QueueRoutingEntry {
  workerName: string;
  projectId: string;
  queueName: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);
    const slug = extractSlug(url.hostname, env.BASE_HOSTNAME);
    const routingKey = slug ?? `domain:${url.hostname}`;

    const routingRaw = await env.ROUTING.get(routingKey);
    if (!routingRaw) {
      return new Response("Not Found", { status: 404 });
    }

    const routing: RoutingEntry = JSON.parse(routingRaw);

    // Check if project is suspended
    if (routing.suspended) {
      return Response.json(
        { error: "usage limit exceeded", reason: routing.suspended },
        { status: 429 },
      );
    }

    const pathname = url.pathname;
    let requestType: RequestType = "static";

    const meter = (response: Response) => {
      ctx.waitUntil(
        Promise.resolve().then(() => {
          recordRequest(env, {
            projectId: routing.projectId,
            type: requestType,
            method: request.method,
            status: response.status,
            responseBytes: Number(response.headers.get("content-length") ?? 0),
            durationMs: Date.now() - startTime,
            slug: slug ?? url.hostname,
          });
          if (routing.userId) {
            sendUsageEvent(env, {
              projectId: routing.projectId,
              userId: routing.userId,
              slug: slug ?? url.hostname,
              requests: 1,
              responseBytes: Number(response.headers.get("content-length") ?? 0),
            });
          }
        }),
      );
      return response;
    };

    // ISR: stale-while-revalidate for configured paths
    if (routing.ssr && routing.revalidate) {
      const isrTtl = resolvePathTtl(routing.revalidate, pathname);
      if (isrTtl > 0 && request.method === "GET" && !shouldBypassIsr(request)) {
        const cached = await readIsrCache(env, routing.projectId, pathname);
        if (cached) {
          const stale = isStale(cached);
          if (stale) {
            ctx.waitUntil(revalidateInBackground(env, routing, request, pathname, isrTtl));
          }
          requestType = "isr";
          return meter(isrCacheResponse(cached, stale));
        }

        // Cache miss: render via worker, cache in background
        requestType = "isr";
        const worker = getWorker(env, routing);
        const workerResponse = await worker.fetch(request);
        const ttl = resolveRevalidateTtl(workerResponse, isrTtl);
        if (ttl > 0 && workerResponse.ok) {
          ctx.waitUntil(writeIsrCache(env, routing.projectId, pathname, workerResponse, ttl));
          const headers = new Headers(workerResponse.headers);
          headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
          headers.set("x-isr-cache", "MISS");
          return meter(
            new Response(workerResponse.body, { status: workerResponse.status, headers }),
          );
        }
        return meter(workerResponse);
      }
    }

    // Dispatch to user worker — CF handles static assets transparently
    const worker = getWorker(env, routing);
    try {
      const response = await worker.fetch(request);

      // Classify for metering
      if (pathname.startsWith("/api/") || pathname === "/api") {
        requestType = "api";
      } else if (routing.ssr && !hasExtension(pathname)) {
        requestType = "ssr";
      }

      // Write ISR cache on miss
      if (routing.revalidate) {
        const isrTtl = resolvePathTtl(routing.revalidate, pathname);
        if (isrTtl > 0 && response.ok && requestType === "ssr") {
          ctx.waitUntil(writeIsrCache(env, routing.projectId, pathname, response, isrTtl));
        }
      }

      return meter(response);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Worker exceeded")) {
        return meter(Response.json({ error: "CPU limit exceeded" }, { status: 429 }));
      }
      throw err;
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Look up which user worker handles this queue
    const routingRaw = await env.ROUTING.get(`queue:${batch.queue}`);
    if (!routingRaw) {
      batch.ackAll();
      return;
    }
    const { workerName, queueName } = JSON.parse(routingRaw) as QueueRoutingEntry;

    // Serialize batch for relay
    const messages = [...batch.messages].map((m) => ({
      id: m.id,
      timestamp: m.timestamp.toISOString(),
      body: m.body,
      attempts: m.attempts,
    }));

    const worker = env.DISPATCH.get(workerName);
    try {
      const res = await worker.fetch(
        new Request("https://internal/__queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ queue: queueName, messages }),
        }),
      );

      if (res.ok) {
        batch.ackAll();
      } else {
        batch.retryAll();
      }
    } catch {
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

/** Get a dispatch worker, applying custom limits if configured. */
function getWorker(env: Env, routing: RoutingEntry): Fetcher {
  if (routing.limits) {
    return env.DISPATCH.get(routing.workerName, {}, { limits: routing.limits });
  }
  return env.DISPATCH.get(routing.workerName);
}

/**
 * Revalidate an ISR page in the background.
 * Dispatches to the user worker, writes the result to R2.
 * Errors are caught and logged — serve stale, don't retry.
 */
async function revalidateInBackground(
  env: Env,
  routing: RoutingEntry,
  request: Request,
  pathname: string,
  defaultTtl: number,
): Promise<void> {
  try {
    const worker = getWorker(env, routing);
    const response = await worker.fetch(request);
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    if (ttl > 0 && response.ok) {
      await writeIsrCache(env, routing.projectId, pathname, response, ttl);
    } else if (ttl === 0) {
      // Worker permanently opted out — remove stale R2 entry
      await deleteIsrCache(env, routing.projectId, pathname);
    }
  } catch (err) {
    console.error("ISR revalidation failed:", err);
  }
}

function hasExtension(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? "";
  return lastSegment.includes(".");
}
