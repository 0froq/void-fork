import type { Env } from "./env";
import { extractSlug } from "./hostname";
import { serveStaticAsset, serveStaticAssetWithFallback, serveSSGAsset } from "./static";

interface RoutingEntry {
  workerName?: string;
  projectId: string;
  ssr?: boolean;
  mode?: "spa" | "ssg";
  version?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const slug = extractSlug(url.hostname);

    if (!slug) {
      return new Response("Not Found", { status: 404 });
    }

    // Look up routing info from KV (needed for cache version)
    const routingRaw = await env.ROUTING.get(slug);
    if (!routingRaw) {
      return new Response("Project not found", { status: 404 });
    }

    const routing: RoutingEntry = JSON.parse(routingRaw);

    // Versioned cache key: each deploy writes a new version to KV,
    // so old cache entries are instantly bypassed without purging.
    const cache = caches.default;
    const cacheKey = routing.version
      ? new Request(`${request.url}?_v=${routing.version}`)
      : request;

    if (request.method === "GET") {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    // Static-only deploys (no worker)
    if (!routing.workerName) {
      if (routing.mode === "ssg") {
        return cacheResponse(
          ctx,
          cache,
          cacheKey,
          await serveSSGAsset(env, routing.projectId, url.pathname),
        );
      }
      return cacheResponse(
        ctx,
        cache,
        cacheKey,
        await serveStaticAssetWithFallback(env, routing.projectId, url.pathname),
      );
    }

    // API routes → dispatch to user worker (not cached here)
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      const worker = env.DISPATCH.get(routing.workerName);
      return worker.fetch(request);
    }

    // Everything else → static assets first.
    // If SSR is enabled and static misses, dispatch to user worker for render().
    if (routing.ssr) {
      const staticResponse = await serveStaticAsset(env, routing.projectId, url.pathname, {
        spaFallback: false,
      });
      if (staticResponse) return cacheResponse(ctx, cache, cacheKey, staticResponse);
      const worker = env.DISPATCH.get(routing.workerName);
      return worker.fetch(request);
    }

    return cacheResponse(
      ctx,
      cache,
      cacheKey,
      await serveStaticAssetWithFallback(env, routing.projectId, url.pathname),
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * Store successful static responses in the edge cache.
 * Uses a versioned cache key so deploys instantly invalidate old entries.
 * TTL is controlled by the Cache-Control headers already set on the response:
 * - Hashed assets: `immutable` (cached ~1 year)
 * - Non-hashed (index.html etc): `s-maxage=60` (cached 60s at edge)
 */
function cacheResponse(
  ctx: ExecutionContext,
  cache: Cache,
  cacheKey: Request,
  response: Response,
): Response {
  if (cacheKey.method === "GET" && response.ok) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
