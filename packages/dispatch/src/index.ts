import type { Env } from "./env";
import { applyHeaderRules, type HeaderRule } from "./headers";
import { applyRedirectRules, type RedirectRule } from "./redirects";
import { extractSlug } from "./hostname";
import { resolveStaticPath, getContentType } from "./static";
import type { AssetConfig } from "./static";
import {
  readIsrCache,
  writeIsrCache,
  deleteIsrCache,
  isStale,
  isrCacheResponse,
  isrEdgeCacheKey,
  isrEdgeCacheKeyJson,
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
  staticDeploymentId?: string;
  assetConfig?: AssetConfig;
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
    let requestType: RequestType =
      request.headers.get("upgrade")?.toLowerCase() === "websocket" ? "websocket" : "static";

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
      const res = new Response(response.body, response);
      res.headers.set("X-Hosted-By", "void.cloud");
      return res;
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
        // Cache miss — fetch from KV/R2 for static deployments, or invoke worker
        if (routing.staticDeploymentId) {
          const manifestRaw = await env.ROUTING.get(`manifest:${routing.staticDeploymentId}`, {
            cacheTtl: 86400,
          });
          const assetManifest: Record<string, string> = manifestRaw ? JSON.parse(manifestRaw) : {};
          const hash = assetManifest[pathname];
          const response = hash
            ? ((await fetchStaticAsset(env, hash, pathname)) ??
              new Response("Not Found", { status: 404 }))
            : new Response("Not Found", { status: 404 });
          if (response.ok) {
            const res = new Response(response.body, response);
            res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return meter(res);
          }
          return meter(response);
        }
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
    // Pages protocol (X-VoidPages) uses a separate JSON edge cache; HTML uses R2+edge.
    if (routing.ssr && routing.revalidate) {
      const isrTtl = resolvePathTtl(routing.revalidate, pathname);
      if (isrTtl > 0 && request.method === "GET" && !shouldBypassIsr(request)) {
        const isPagesRequest = request.headers.has("X-VoidPages");
        const cache = caches.default;

        // Pages protocol: check JSON edge cache, fall through on miss
        if (isPagesRequest) {
          const jsonCacheKey = isrEdgeCacheKeyJson(request, pathname);
          const jsonCached = await cache.match(jsonCacheKey);
          if (jsonCached) {
            requestType = "isr";
            return meter(jsonCached);
          }
          // Miss — fall through to general dispatch (worker returns JSON for X-VoidPages)
        } else {
          // HTML path: Edge → R2 → Worker
          const cacheKey = isrEdgeCacheKey(request, pathname);
          const jsonCacheKey = isrEdgeCacheKeyJson(request, pathname);

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
                revalidateInBackground(
                  env,
                  routing,
                  request,
                  pathname,
                  isrTtl,
                  cacheKey,
                  jsonCacheKey,
                ),
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
            // Populate JSON edge cache from x-void-page-data header
            const pageData = workerResponse.headers.get("x-void-page-data");
            if (pageData) {
              ctx.waitUntil(
                cache.put(
                  jsonCacheKey,
                  new Response(pageData, {
                    headers: {
                      "content-type": "application/json",
                      "Cache-Control": `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
                      "x-isr-cache": "MISS",
                    },
                  }),
                ),
              );
            }
            const headers = new Headers(workerResponse.headers);
            headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
            headers.set("x-isr-cache", "MISS");
            headers.delete("x-void-page-data");
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
    }

    // Edge-cache non-hashed static assets using deploy-versioned cache keys
    const isStaticCandidate =
      request.method === "GET" &&
      routing.version &&
      !(pathname.startsWith("/api/") || pathname === "/api") &&
      (hasExtension(pathname) || !routing.ssr);

    let staticCacheKey: Request | undefined;
    if (isStaticCandidate) {
      const cacheUrl = new URL(request.url);
      cacheUrl.search = `?_v=${routing.version}`;
      staticCacheKey = new Request(cacheUrl.toString());
      const cached = await caches.default.match(staticCacheKey);
      if (cached) {
        requestType = "static";
        return meter(cached);
      }
    }

    // KV/R2-backed static serving — no WfP worker needed
    if (routing.staticDeploymentId) {
      const manifestRaw = await env.ROUTING.get(`manifest:${routing.staticDeploymentId}`, {
        cacheTtl: 86400,
      });
      if (!manifestRaw) {
        return meter(new Response("Deployment manifest not found", { status: 502 }));
      }
      const assetManifest: Record<string, string> = JSON.parse(manifestRaw);
      const assetConfig: AssetConfig = routing.assetConfig ?? {};

      const resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
      if (!resolved) {
        return meter(new Response("Not Found", { status: 404 }));
      }

      if (resolved.redirect) {
        return meter(
          new Response(null, {
            status: 308,
            headers: { Location: resolved.redirect },
          }),
        );
      }

      const assetResponse = await fetchStaticAsset(env, resolved.hash, resolved.path);
      if (!assetResponse) {
        return meter(new Response("Asset not found", { status: 404 }));
      }

      const status = resolved.notFound ? 404 : 200;
      const response = new Response(assetResponse.body, {
        status,
        headers: assetResponse.headers,
      });
      const finalRes = applyHeaderRules(response, pathname, routing.headerRules);

      // Populate edge cache (same pattern as existing deploy-versioned static cache)
      const edgeCacheKey =
        staticCacheKey ??
        (request.method === "GET"
          ? new Request(`${url.origin}${pathname}?_v=${routing.staticDeploymentId}`)
          : undefined);
      if (edgeCacheKey && status === 200) {
        const cached = new Response(finalRes.clone().body, finalRes);
        cached.headers.set(
          "Cache-Control",
          "public, s-maxage=31536000, max-age=0, must-revalidate",
        );
        ctx.waitUntil(caches.default.put(edgeCacheKey, cached.clone()));
      }

      return meter(finalRes);
    }

    // Dispatch to user worker — CF handles static assets transparently
    const worker = getWorker(env, routing);
    try {
      const response = await worker.fetch(request);

      // Cache static asset at edge if eligible
      if (staticCacheKey && response.ok && !hasCacheOptOut(response)) {
        const res = new Response(response.body, response);
        res.headers.delete("x-void-page-data");
        const finalRes = applyHeaderRules(res, pathname, routing.headerRules);
        finalRes.headers.set(
          "Cache-Control",
          "public, s-maxage=31536000, max-age=0, must-revalidate",
        );
        ctx.waitUntil(caches.default.put(staticCacheKey, finalRes.clone()));
        return meter(finalRes);
      }

      // Classify for metering
      if (pathname.startsWith("/api/") || pathname === "/api") {
        requestType = "api";
      } else if (routing.ssr && !hasExtension(pathname)) {
        requestType = "ssr";
      }

      // Write ISR cache on miss — skip pages protocol responses (JSON, not HTML)
      if (routing.revalidate && !request.headers.has("X-VoidPages")) {
        const isrTtl = resolvePathTtl(routing.revalidate, pathname);
        if (isrTtl > 0 && response.ok && requestType === "ssr") {
          ctx.waitUntil(writeIsrCache(env, routing.projectId, pathname, response, isrTtl));
          // Also populate JSON edge cache from x-void-page-data header
          const pageData = response.headers.get("x-void-page-data");
          if (pageData) {
            const jsonCacheKey = isrEdgeCacheKeyJson(request, pathname);
            ctx.waitUntil(
              caches.default.put(
                jsonCacheKey,
                new Response(pageData, {
                  headers: {
                    "content-type": "application/json",
                    "Cache-Control": `public, s-maxage=${isrTtl}, max-age=0, must-revalidate`,
                    "x-isr-cache": "MISS",
                  },
                }),
              ),
            );
          }
        }
      }

      // Strip internal header before returning to client
      if (response.headers.has("x-void-page-data")) {
        const stripped = new Response(response.body, response);
        stripped.headers.delete("x-void-page-data");
        return meter(applyHeaderRules(stripped, pathname, routing.headerRules));
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
      batch.retryAll();
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

      if (!res.ok) {
        batch.retryAll();
        return;
      }

      let result: {
        ok?: boolean;
        decisions?: Record<string, { action: string; delaySeconds?: number }>;
      };
      try {
        result = await res.json();
      } catch {
        // Non-JSON 2xx = legacy framework, treat as success
        batch.ackAll();
        return;
      }

      if (!result.decisions) {
        // No decisions = legacy protocol, batch fallback
        if (result.ok !== false) batch.ackAll();
        else batch.retryAll();
        return;
      }

      // Apply per-message decisions
      const msgMap = new Map(batch.messages.map((m) => [m.id, m]));
      for (const [id, decision] of Object.entries(result.decisions)) {
        const cfMsg = msgMap.get(id);
        if (!cfMsg) continue;
        if (decision.action === "ack") cfMsg.ack();
        else if (decision.action === "retry")
          cfMsg.retry(
            decision.delaySeconds != null ? { delaySeconds: decision.delaySeconds } : undefined,
          );
      }

      // Undecided messages: if handler failed, retry all (individual decisions survive per CF)
      if (result.ok === false) batch.retryAll();
      // If ok=true, undecided messages get implicit ack (CF default on successful consumer return)
    } catch {
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Fetch a static asset from KV (small files) or R2 (large files, prefixed with `!`).
 * Returns null if the asset is not found.
 */
async function fetchStaticAsset(env: Env, hash: string, path: string): Promise<Response | null> {
  const isLarge = hash.startsWith("!");
  const cleanHash = isLarge ? hash.slice(1) : hash;
  const key = `assets/${cleanHash}`;

  if (isLarge) {
    const obj = await env.STATIC_ASSETS_R2.get(key);
    if (!obj) return null;
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType ?? getContentType(path),
        ETag: obj.httpEtag,
        ...(obj.size ? { "Content-Length": String(obj.size) } : {}),
      },
    });
  }

  const { value, metadata } = await env.STATIC_ASSETS.getWithMetadata<{ ct: string }>(key, {
    type: "arrayBuffer",
    cacheTtl: 86400,
  });
  if (!value) return null;
  const contentType = metadata?.ct ?? getContentType(path);
  return new Response(value, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String((value as ArrayBuffer).byteLength),
    },
  });
}

/** Get a dispatch worker, applying custom limits if configured. */
function getWorker(env: Env, routing: RoutingEntry): Fetcher {
  if (routing.limits) {
    return env.DISPATCH.get(routing.workerName, {}, { limits: routing.limits });
  }
  return env.DISPATCH.get(routing.workerName);
}

/**
 * Revalidate an ISR page in the background.
 * Dispatches to the user worker (always as HTML, no X-VoidPages), writes HTML
 * to R2 + HTML edge cache, and populates JSON edge cache from x-void-page-data.
 * Errors are caught and logged — serve stale, don't retry.
 */
async function revalidateInBackground(
  env: Env,
  routing: RoutingEntry,
  request: Request,
  pathname: string,
  defaultTtl: number,
  cacheKey: Request,
  jsonCacheKey: Request,
): Promise<void> {
  try {
    const worker = getWorker(env, routing);
    // Strip X-VoidPages so the worker always returns HTML
    const cleanHeaders = new Headers(request.headers);
    cleanHeaders.delete("X-VoidPages");
    const cleanRequest = new Request(request.url, {
      method: request.method,
      headers: cleanHeaders,
    });
    const response = await worker.fetch(cleanRequest);
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    const cache = caches.default;
    if (ttl > 0 && response.ok) {
      await writeIsrCache(env, routing.projectId, pathname, response, ttl);
      // Update HTML edge cache with fresh response
      const headers = new Headers(response.headers);
      headers.set("x-isr-cache", "HIT");
      headers.set("Cache-Control", `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
      headers.delete("set-cookie");
      headers.delete("x-void-page-data");
      await cache.put(
        cacheKey,
        new Response(response.clone().body, {
          status: response.status,
          headers,
        }),
      );
      // Update JSON edge cache from x-void-page-data header
      const pageData = response.headers.get("x-void-page-data");
      if (pageData) {
        await cache.put(
          jsonCacheKey,
          new Response(pageData, {
            headers: {
              "content-type": "application/json",
              "Cache-Control": `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
              "x-isr-cache": "HIT",
            },
          }),
        );
      }
    } else if (ttl === 0) {
      // Worker permanently opted out — remove stale R2 + edge entries + JSON edge
      await deleteIsrCache(env, routing.projectId, pathname);
      await cache.delete(cacheKey);
      await cache.delete(jsonCacheKey);
    }
  } catch (err) {
    console.error("ISR revalidation failed:", err);
  }
}

function hasExtension(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

function hasCacheOptOut(response: Response): boolean {
  const cc = response.headers.get("Cache-Control");
  if (!cc) return false;
  return /\b(private|no-store|no-cache)\b/.test(cc);
}
