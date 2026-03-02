import type { Env } from "./env";
import { applyHeaderRules, type HeaderRule } from "./headers";
import { applyRedirectRules, type RedirectRule } from "./redirects";
import { extractSlug } from "./hostname";
import {
  readIsrCache,
  writeIsrCache,
  deleteIsrCache,
  isStale,
  isrCacheResponse,
  isrEdgeCacheKey,
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
  hashedAssetsPrefix?: string;
  headerRules?: HeaderRule[];
  redirectRules?: RedirectRule[];
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

    // Health check short-circuit — bypass KV lookup entirely
    if (url.pathname === "/health" && request.headers.get("X-Health-Check") === "void-admin") {
      return Response.json({ ok: true });
    }

    const slug = extractSlug(url.hostname, env.BASE_HOSTNAME);
    const routingKey = slug ?? `domain:${url.hostname}`;

    const routingRaw = await env.ROUTING.get(routingKey, { cacheTtl: 60 });
    if (!routingRaw) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "public, max-age=30" },
      });
    }

    const routing: RoutingEntry = JSON.parse(routingRaw);

    // Check if project is suspended
    if (routing.suspended) {
      return Response.json(
        { error: "usage limit exceeded", reason: routing.suspended },
        { status: 429, headers: { "Cache-Control": "public, s-maxage=30, max-age=0" } },
      );
    }

    const pathname = url.pathname;
    let requestType: RequestType = "static";

    const meter = (response: Response) => {
      const responseBytes = Number(response.headers.get("content-length") ?? 0);
      recordRequest(env, {
        projectId: routing.projectId,
        type: requestType,
        method: request.method,
        status: response.status,
        responseBytes,
        durationMs: Date.now() - startTime,
        slug: slug ?? url.hostname,
      });
      if (routing.userId) {
        ctx.waitUntil(
          sendUsageEvent(env, {
            projectId: routing.projectId,
            userId: routing.userId,
            slug: slug ?? url.hostname,
            requests: 1,
            responseBytes,
          }),
        );
      }
      return response;
    };

    // Redirect rules — short-circuit before any worker invocation
    if (routing.redirectRules?.length) {
      const redirect = applyRedirectRules(pathname, routing.redirectRules);
      if (redirect) return meter(redirect);
    }

    // Edge-cache hashed static assets (immutable, content-addressed URLs)
    if (request.method === "GET" && routing.hashedAssetsPrefix) {
      const prefix = "/" + routing.hashedAssetsPrefix + "/";
      if (pathname.startsWith(prefix)) {
        // Normalize cache key: strip query strings — hashed filenames are content-addressed
        const cacheUrl = new URL(request.url);
        cacheUrl.search = "";
        const cacheKey = new Request(cacheUrl.toString());

        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached?.headers.get("Cache-Control")?.includes("immutable")) {
          return meter(cached);
        }
        // Cache miss — invoke worker, cache immutable response
        try {
          const worker = getWorker(env, routing);
          const response = await worker.fetch(request);
          if (response.ok) {
            const res = new Response(response.body, response);
            res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return meter(res);
          }
          return meter(response);
        } catch (err) {
          if (err instanceof Error && err.message.includes("Worker exceeded")) {
            return meter(Response.json({ error: "CPU limit exceeded" }, { status: 429 }));
          }
          throw err;
        }
      }
    }

    // ISR: stale-while-revalidate for configured paths
    // Two-layer cache: Edge (per-colo, sub-ms) → R2 (global, ~50ms) → Worker (render)
    if (routing.ssr && routing.revalidate) {
      const isrTtl = resolvePathTtl(routing.revalidate, pathname);
      if (isrTtl > 0 && request.method === "GET" && !shouldBypassIsr(request)) {
        const cacheKey = isrEdgeCacheKey(request, pathname);
        const cache = caches.default;

        // L1: Edge cache (per-colo)
        const edgeCached = await cache.match(cacheKey);
        if (edgeCached) {
          requestType = "isr";
          return meter(edgeCached);
        }

        // L2: R2 (global)
        const cached = await readIsrCache(env, routing.projectId, pathname);
        if (cached) {
          const stale = isStale(cached);
          if (stale) {
            ctx.waitUntil(
              revalidateInBackground(env, routing, request, pathname, isrTtl, cacheKey),
            );
          }
          requestType = "isr";
          const response = isrCacheResponse(cached, stale);
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return meter(response);
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
          const response = new Response(workerResponse.body, {
            status: workerResponse.status,
            headers,
          });
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return meter(response);
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

      return meter(applyHeaderRules(response, pathname, routing.headerRules));
    } catch (err) {
      if (err instanceof Error && err.message.includes("Worker exceeded")) {
        return meter(Response.json({ error: "CPU limit exceeded" }, { status: 429 }));
      }
      throw err;
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Look up which user worker handles this queue
    const routingRaw = await env.ROUTING.get(`queue:${batch.queue}`, { cacheTtl: 60 });
    if (!routingRaw) {
      batch.ackAll();
      return;
    }
    const { workerName, queueName } = JSON.parse(routingRaw) as QueueRoutingEntry;

    // Serialize batch for relay
    const messages = Array.from(batch.messages, (m) => ({
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
  cacheKey: Request,
): Promise<void> {
  try {
    const worker = getWorker(env, routing);
    const response = await worker.fetch(request);
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    const cache = caches.default;
    if (ttl > 0 && response.ok) {
      await writeIsrCache(env, routing.projectId, pathname, response, ttl);
      // Update edge cache with fresh response
      const headers = new Headers(response.headers);
      headers.set("x-isr-cache", "HIT");
      headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
      headers.delete("set-cookie");
      await cache.put(
        cacheKey,
        new Response(response.clone().body, {
          status: response.status,
          headers,
        }),
      );
    } else if (ttl === 0) {
      // Worker permanently opted out — remove stale R2 + edge entries
      await deleteIsrCache(env, routing.projectId, pathname);
      await cache.delete(cacheKey);
    }
  } catch (err) {
    console.error("ISR revalidation failed:", err);
  }
}

function hasExtension(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}
