import type { Env } from "./env";
import { applyHeaderRules, type HeaderRule } from "./headers";
import { extractSlug } from "./hostname";
import {
  readIsrCache,
  writeIsrCache,
  isStale,
  isrCacheResponse,
  resolveRevalidateTtl,
  shouldBypassIsr,
} from "./isr";
import { recordRequest, type RequestType } from "./metering";
import { serveStaticAsset, serveStaticAssetWithFallback, serveSSGAsset } from "./static";

interface RoutingEntry {
  workerName?: string;
  projectId: string;
  ssr?: boolean;
  revalidate?: number;
  mode?: "spa" | "ssg";
  version?: string;
  headers?: HeaderRule[];
  limits?: Record<string, number>;
  suspended?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);
    const slug = extractSlug(url.hostname);
    const routingKey = slug ?? `domain:${url.hostname}`;

    // Look up routing info from KV (needed for cache version)
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

    // Versioned cache key: each deploy writes a new version to KV,
    // so old cache entries are instantly bypassed without purging.
    const cache = caches.default;
    const cacheKey = routing.version
      ? new Request(`${request.url}?_v=${routing.version}`)
      : request;

    if (request.method === "GET") {
      const cached = await cache.match(cacheKey);
      if (cached) return conditionalResponse(request, cached);
    }

    const pathname = url.pathname;
    let requestType: RequestType = "static";

    const meter = (response: Response) => {
      ctx.waitUntil(
        Promise.resolve().then(() =>
          recordRequest(env, {
            projectId: routing.projectId,
            type: requestType,
            method: request.method,
            status: response.status,
            responseBytes: Number(response.headers.get("content-length") ?? 0),
            durationMs: Date.now() - startTime,
            slug: slug ?? url.hostname,
          }),
        ),
      );
      return response;
    };

    // Static-only deploys (no worker)
    if (!routing.workerName) {
      if (routing.mode === "ssg") {
        return meter(
          cacheResponse(
            request,
            ctx,
            cache,
            cacheKey,
            applyHeaderRules(
              await serveSSGAsset(env, routing.projectId, pathname),
              pathname,
              routing.headers,
            ),
          ),
        );
      }
      return meter(
        cacheResponse(
          request,
          ctx,
          cache,
          cacheKey,
          applyHeaderRules(
            await serveStaticAssetWithFallback(env, routing.projectId, pathname),
            pathname,
            routing.headers,
          ),
        ),
      );
    }

    // API routes → dispatch to user worker (not cached here)
    if (pathname.startsWith("/api/") || pathname === "/api") {
      requestType = "api";
      const worker = getWorker(env, routing);
      try {
        return meter(await worker.fetch(request));
      } catch (err) {
        if (err instanceof Error && err.message.includes("Worker exceeded")) {
          return meter(Response.json({ error: "CPU limit exceeded" }, { status: 429 }));
        }
        throw err;
      }
    }

    // Everything else → static assets first.
    // If SSR is enabled and static misses, dispatch to user worker for render().
    if (routing.ssr) {
      const staticResponse = await serveStaticAsset(env, routing.projectId, pathname, {
        spaFallback: false,
      });
      if (staticResponse) {
        return meter(
          cacheResponse(
            request,
            ctx,
            cache,
            cacheKey,
            applyHeaderRules(staticResponse, pathname, routing.headers),
          ),
        );
      }

      // ISR: stale-while-revalidate for SSR pages
      const isrTtl = routing.revalidate;
      if (isrTtl && isrTtl > 0 && request.method === "GET" && !shouldBypassIsr(request)) {
        const cached = await readIsrCache(env, routing.projectId, pathname);
        if (cached) {
          const stale = isStale(cached);
          if (stale) {
            // Serve stale, revalidate in background
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
        }
        return meter(workerResponse);
      }

      requestType = "ssr";
      const ssrWorker = getWorker(env, routing);
      return meter(await ssrWorker.fetch(request));
    }

    return meter(
      cacheResponse(
        request,
        ctx,
        cache,
        cacheKey,
        applyHeaderRules(
          await serveStaticAssetWithFallback(env, routing.projectId, pathname),
          pathname,
          routing.headers,
        ),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

/** Get a dispatch worker, applying custom limits if configured. */
function getWorker(env: Env, routing: RoutingEntry): Fetcher {
  if (routing.limits) {
    return env.DISPATCH.get(routing.workerName!, {}, { limits: routing.limits });
  }
  return env.DISPATCH.get(routing.workerName!);
}

/**
 * Store successful static responses in the edge cache.
 * Uses a versioned cache key so deploys instantly invalidate old entries.
 * TTL is controlled by the Cache-Control headers already set on the response:
 * - Hashed assets: `immutable` (cached ~1 year)
 * - Non-hashed (index.html etc): `s-maxage=60` (cached 60s at edge)
 */
function cacheResponse(
  request: Request,
  ctx: ExecutionContext,
  cache: Cache,
  cacheKey: Request,
  response: Response,
): Response {
  if (cacheKey.method === "GET" && response.ok) {
    // Always cache the full 200 response at the edge
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return conditionalResponse(request, response);
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
    }
  } catch (err) {
    console.error("ISR revalidation failed:", err);
  }
}

/**
 * Check If-None-Match against the response's ETag.
 * Returns 304 Not Modified when they match, avoiding sending the body.
 */
function conditionalResponse(request: Request, response: Response): Response {
  const etag = response.headers.get("ETag");
  if (!etag) return response;

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (!ifNoneMatch) return response;

  // Weak comparison per HTTP spec: strip W/ prefix before comparing
  const normalize = (tag: string) => tag.replace(/^W\//, "");
  const clientTags = ifNoneMatch.split(",").map((t) => normalize(t.trim()));
  if (clientTags.includes(normalize(etag))) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": response.headers.get("Cache-Control") ?? "",
      },
    });
  }

  return response;
}
