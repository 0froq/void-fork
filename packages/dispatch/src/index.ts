import type { Env } from "./env";
import { applyHeaderRules, type HeaderRule } from "./headers";
import { extractSlug } from "./hostname";
import { serveStaticAsset, serveStaticAssetWithFallback, serveSSGAsset } from "./static";

interface RoutingEntry {
  workerName?: string;
  projectId: string;
  ssr?: boolean;
  mode?: "spa" | "ssg";
  version?: string;
  headers?: HeaderRule[];
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
      if (cached) return conditionalResponse(request, cached);
    }

    const pathname = url.pathname;

    // Static-only deploys (no worker)
    if (!routing.workerName) {
      if (routing.mode === "ssg") {
        return cacheResponse(
          request,
          ctx,
          cache,
          cacheKey,
          applyHeaderRules(
            await serveSSGAsset(env, routing.projectId, pathname),
            pathname,
            routing.headers,
          ),
        );
      }
      return cacheResponse(
        request,
        ctx,
        cache,
        cacheKey,
        applyHeaderRules(
          await serveStaticAssetWithFallback(env, routing.projectId, pathname),
          pathname,
          routing.headers,
        ),
      );
    }

    // API routes → dispatch to user worker (not cached here)
    if (pathname.startsWith("/api/") || pathname === "/api") {
      const worker = env.DISPATCH.get(routing.workerName);
      return worker.fetch(request);
    }

    // Everything else → static assets first.
    // If SSR is enabled and static misses, dispatch to user worker for render().
    if (routing.ssr) {
      const staticResponse = await serveStaticAsset(env, routing.projectId, pathname, {
        spaFallback: false,
      });
      if (staticResponse) {
        return cacheResponse(
          request,
          ctx,
          cache,
          cacheKey,
          applyHeaderRules(staticResponse, pathname, routing.headers),
        );
      }
      const worker = env.DISPATCH.get(routing.workerName);
      return worker.fetch(request);
    }

    return cacheResponse(
      request,
      ctx,
      cache,
      cacheKey,
      applyHeaderRules(
        await serveStaticAssetWithFallback(env, routing.projectId, pathname),
        pathname,
        routing.headers,
      ),
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
