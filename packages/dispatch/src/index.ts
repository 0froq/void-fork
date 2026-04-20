import type { Env } from './env';
import { createErrorResponse } from './error-page';
import { applyHeaderRules, type HeaderRule } from './headers';
import { extractSlug } from './hostname';
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
  extractPageDataFromHtml,
  normalizePageDataForJsonCache,
} from './isr';
import { recordRequest, sendUsageEvent, type RequestType } from './metering';
import { applyRedirectRules, type RedirectRule } from './redirects';
import { resolveStaticPath, getContentType } from './static';
import type { AssetConfig } from './static';

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
  // HMAC-signed proxy token matching the user worker's __VOID_PROXY_TOKEN
  // binding. The framework-generated /__void/queue handler rejects relays
  // without a matching `x-void-internal` header with 401. Absent on entries
  // written by older API versions.
  proxyToken?: string;
}

const CLIENT_REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

function clientRevalidateResponse(response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
  return res;
}

function jsonCacheResponse(pageData: string, ttl: number, state: 'HIT' | 'MISS'): Response {
  return new Response(pageData, {
    headers: {
      'content-type': 'application/json',
      'Cache-Control': `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
      'x-isr-cache': state,
    },
  });
}

async function populateJsonEdgeCache(
  cache: Cache,
  cacheKey: Request,
  response: Response,
  ttl: number,
  state: 'HIT' | 'MISS',
): Promise<void> {
  const fromHeader = response.headers.get('x-void-page-data');
  const pageData = fromHeader
    ? normalizePageDataForJsonCache(fromHeader)
    : extractPageDataFromHtml(await response.clone().text());
  if (!pageData) {
    return;
  }
  await cache.put(cacheKey, jsonCacheResponse(pageData, ttl, state));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);

    // Block Void-internal routes from external HTTP access.
    // Only /__void/* is reserved by the platform — other __ prefixes
    // (e.g. /__nuxt_content, /__og-image__) are user/framework assets.
    if (
      url.pathname.startsWith('/__void/') ||
      // Legacy: old SDK versions register these top-level paths. Block them
      // at the edge so we don't rely solely on worker-side token checks.
      // TODO: remove once all deployed workers use /__void/* paths. See #88
      url.pathname === '/__scheduled' ||
      url.pathname === '/__queue'
    ) {
      return createErrorResponse(request, 404, 'Not Found');
    }

    // Health check short-circuit — bypass KV lookup entirely
    if (url.pathname === '/health' && request.headers.get('X-Health-Check') === 'void-admin') {
      return Response.json({ ok: true });
    }

    const slug = extractSlug(url.hostname, env.BASE_HOSTNAME);
    const routingKey = slug ?? `domain:${url.hostname}`;

    const routingRaw = await env.ROUTING.get(routingKey, { cacheTtl: 60 });
    if (!routingRaw) {
      return createErrorResponse(request, 404, 'Not Found', {
        'Cache-Control': 'public, max-age=30',
      });
    }

    const routing: RoutingEntry = JSON.parse(routingRaw);

    // Check if project is suspended
    if (routing.suspended) {
      return Response.json(
        { error: 'usage limit exceeded', reason: routing.suspended },
        { status: 429, headers: { 'Cache-Control': 'public, s-maxage=30, max-age=0' } },
      );
    }

    const pathname = url.pathname;
    let requestType: RequestType =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? 'websocket' : 'static';

    const meter = (response: Response) => {
      const responseBytes = Number(response.headers.get('content-length') ?? 0);
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
            ...(response.status >= 500 && { status: response.status }),
          }),
        );
      }
      const res = new Response(response.body, response);
      res.headers.set('X-Hosted-By', 'void.cloud');
      return res;
    };

    // Redirect rules — short-circuit before any worker invocation
    if (routing.redirectRules?.length) {
      const redirect = applyRedirectRules(pathname, routing.redirectRules);
      if (redirect) {
        return meter(redirect);
      }
    }

    // Edge-cache hashed static assets (immutable, content-addressed URLs)
    if (request.method === 'GET' && routing.hashedAssetsPrefix) {
      const prefix = '/' + routing.hashedAssetsPrefix + '/';
      if (pathname.startsWith(prefix)) {
        // Normalize cache key: strip query strings — hashed filenames are content-addressed
        const cacheUrl = new URL(request.url);
        cacheUrl.search = '';
        const cacheKey = new Request(cacheUrl.toString());

        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached?.headers.get('Cache-Control')?.includes('immutable')) {
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
            ? ((await fetchStaticAsset(env, hash, pathname, routing.projectId)) ??
              createErrorResponse(request, 404, 'Not Found'))
            : createErrorResponse(request, 404, 'Not Found');
          if (response.ok) {
            const res = new Response(response.body, response);
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
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
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return meter(res);
          }
          return meter(response);
        } catch (err) {
          if (err instanceof Error && err.message.includes('Worker exceeded')) {
            return meter(Response.json({ error: 'CPU limit exceeded' }, { status: 429 }));
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
      if (isrTtl > 0 && request.method === 'GET' && !shouldBypassIsr(request)) {
        const isPagesRequest = request.headers.has('X-VoidPages');
        const isrDeploymentId = routing.version ?? 'legacy';
        const cache = caches.default;

        // Pages protocol: check JSON edge cache, fall through on miss
        if (isPagesRequest) {
          const jsonCacheKey = isrEdgeCacheKeyJson(request, pathname, isrDeploymentId);
          const jsonCached = await cache.match(jsonCacheKey);
          if (jsonCached) {
            requestType = 'isr';
            return meter(clientRevalidateResponse(jsonCached));
          }
          // Miss — fall through to general dispatch (worker returns JSON for X-VoidPages)
        } else {
          // HTML path: Edge → R2 → Worker
          const cacheKey = isrEdgeCacheKey(request, pathname, isrDeploymentId);
          const jsonCacheKey = isrEdgeCacheKeyJson(request, pathname, isrDeploymentId);

          // L1: Edge cache (per-colo)
          const edgeCached = await cache.match(cacheKey);
          if (edgeCached) {
            requestType = 'isr';
            return meter(clientRevalidateResponse(edgeCached));
          }

          // L2: R2 (global)
          const cached = await readIsrCache(env, routing.projectId, isrDeploymentId, pathname);
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
            requestType = 'isr';
            const cacheResponse = isrCacheResponse(cached, stale);
            ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));
            return meter(clientRevalidateResponse(cacheResponse));
          }

          // Cache miss: render via worker, cache in background
          requestType = 'isr';
          const worker = getWorker(env, routing);
          const workerResponse = await worker.fetch(request);
          const ttl = resolveRevalidateTtl(workerResponse, isrTtl);
          if (ttl > 0 && workerResponse.ok) {
            ctx.waitUntil(
              writeIsrCache(env, routing.projectId, isrDeploymentId, pathname, workerResponse, ttl),
            );
            ctx.waitUntil(populateJsonEdgeCache(cache, jsonCacheKey, workerResponse, ttl, 'MISS'));
            const cacheHeaders = new Headers(workerResponse.headers);
            cacheHeaders.set(
              'Cache-Control',
              `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
            );
            cacheHeaders.set('x-isr-cache', 'MISS');
            cacheHeaders.delete('x-void-page-data');
            cacheHeaders.delete('set-cookie');
            const cacheResponse = new Response(workerResponse.clone().body, {
              status: workerResponse.status,
              headers: cacheHeaders,
            });
            ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));

            const clientHeaders = new Headers(cacheHeaders);
            clientHeaders.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
            const clientResponse = new Response(workerResponse.body, {
              status: workerResponse.status,
              headers: clientHeaders,
            });
            return meter(clientResponse);
          }
          return meter(workerResponse);
        }
      }
    }

    // Edge-cache non-hashed static assets using deploy-versioned cache keys
    const isStaticCandidate =
      request.method === 'GET' &&
      routing.version &&
      !(pathname.startsWith('/api/') || pathname === '/api') &&
      (hasExtension(pathname) || !routing.ssr);

    let staticCacheKey: Request | undefined;
    if (isStaticCandidate) {
      const cacheUrl = new URL(request.url);
      cacheUrl.search = `?_v=${routing.version}`;
      staticCacheKey = new Request(cacheUrl.toString());
      const cached = await caches.default.match(staticCacheKey);
      if (cached) {
        requestType = 'static';
        return meter(clientRevalidateResponse(cached));
      }
    }

    // KV/R2-backed static serving — no WfP worker needed
    if (routing.staticDeploymentId) {
      const manifestRaw = await env.ROUTING.get(`manifest:${routing.staticDeploymentId}`, {
        cacheTtl: 86400,
      });
      if (!manifestRaw) {
        return meter(new Response('Deployment manifest not found', { status: 502 }));
      }
      const assetManifest: Record<string, string> = JSON.parse(manifestRaw);
      const assetConfig: AssetConfig = routing.assetConfig ?? {};

      const resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
      if (!resolved) {
        return meter(createErrorResponse(request, 404, 'Not Found'));
      }

      if (resolved.redirect) {
        return meter(
          new Response(null, {
            status: 308,
            headers: { Location: resolved.redirect },
          }),
        );
      }

      const assetResponse = await fetchStaticAsset(
        env,
        resolved.hash,
        resolved.path,
        routing.projectId,
      );
      if (!assetResponse) {
        return meter(createErrorResponse(request, 404, 'Not Found'));
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
        (request.method === 'GET'
          ? new Request(`${url.origin}${pathname}?_v=${routing.staticDeploymentId}`)
          : undefined);
      if (edgeCacheKey && status === 200) {
        const cached = new Response(finalRes.clone().body, finalRes);
        cached.headers.set(
          'Cache-Control',
          'public, s-maxage=31536000, max-age=0, must-revalidate',
        );
        ctx.waitUntil(caches.default.put(edgeCacheKey, cached.clone()));
      }

      return meter(clientRevalidateResponse(finalRes));
    }

    // Dispatch to user worker — CF handles static assets transparently
    const worker = getWorker(env, routing);
    try {
      let dispatchReq = request;
      if (request.bodyUsed) {
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        headers.delete('transfer-encoding');
        dispatchReq = new Request(request.url, { method: request.method, headers });
      }
      const response = await worker.fetch(dispatchReq);

      // Cache static asset at edge if eligible
      if (staticCacheKey && response.ok && !hasCacheOptOut(response)) {
        const res = new Response(response.body, response);
        res.headers.delete('x-void-page-data');
        const finalRes = applyHeaderRules(res, pathname, routing.headerRules);
        const cacheRes = new Response(finalRes.clone().body, finalRes);
        cacheRes.headers.set(
          'Cache-Control',
          'public, s-maxage=31536000, max-age=0, must-revalidate',
        );
        ctx.waitUntil(caches.default.put(staticCacheKey, cacheRes.clone()));
        return meter(clientRevalidateResponse(finalRes));
      }

      // Classify for metering
      if (pathname.startsWith('/api/') || pathname === '/api') {
        requestType = 'api';
      } else if (routing.ssr && !hasExtension(pathname)) {
        requestType = 'ssr';
      }

      // Write ISR cache on miss — skip pages protocol responses (JSON, not HTML)
      // Guard: only cache GET requests without credentials, and respect worker x-revalidate
      if (
        routing.revalidate &&
        !request.headers.has('X-VoidPages') &&
        request.method === 'GET' &&
        !shouldBypassIsr(request)
      ) {
        const configTtl = resolvePathTtl(routing.revalidate, pathname);
        // Config TTL is the gatekeeper — worker x-revalidate can reduce but not enable ISR
        const isrTtl = configTtl > 0 ? resolveRevalidateTtl(response, configTtl) : 0;
        if (isrTtl > 0 && response.ok && requestType === 'ssr') {
          const isrDeploymentId = routing.version ?? 'legacy';
          ctx.waitUntil(
            writeIsrCache(env, routing.projectId, isrDeploymentId, pathname, response, isrTtl),
          );
          const jsonCacheKey = isrEdgeCacheKeyJson(request, pathname, isrDeploymentId);
          ctx.waitUntil(
            populateJsonEdgeCache(caches.default, jsonCacheKey, response, isrTtl, 'MISS'),
          );
        }
      }

      // Strip internal header before returning to client
      if (response.headers.has('x-void-page-data')) {
        const stripped = new Response(response.body, response);
        stripped.headers.delete('x-void-page-data');
        return meter(applyHeaderRules(stripped, pathname, routing.headerRules));
      }
      return meter(applyHeaderRules(response, pathname, routing.headerRules));
    } catch (err) {
      if (err instanceof Error && err.message.includes('Worker exceeded')) {
        return meter(Response.json({ error: 'CPU limit exceeded' }, { status: 429 }));
      }
      throw err;
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Look up which user worker handles this queue
    const routingRaw = await env.ROUTING.get(`queue:${batch.queue}`, { cacheTtl: 60 });
    if (!routingRaw) {
      console.error(
        `[queue-relay] missing routing entry for queue="${batch.queue}"; retrying all messages`,
      );
      batch.retryAll();
      return;
    }
    const { workerName, queueName, proxyToken } = JSON.parse(routingRaw) as QueueRoutingEntry;

    // Serialize batch for relay
    const messages = Array.from(batch.messages, (m) => ({
      id: m.id,
      timestamp: m.timestamp.toISOString(),
      body: m.body,
      attempts: m.attempts,
    }));

    const worker = env.DISPATCH.get(workerName);
    try {
      const body = JSON.stringify({ queue: queueName, messages });
      const queueHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (proxyToken) {
        queueHeaders['x-void-internal'] = proxyToken;
      }
      let res = await worker.fetch(
        new Request('https://internal/__void/queue', {
          method: 'POST',
          headers: queueHeaders,
          body,
        }),
      );
      // Legacy: fall back for workers deployed before the /__void/ migration.
      // TODO: remove once all deployed workers use /__void/* paths.
      if (res.status === 404) {
        res = await worker.fetch(
          new Request('https://internal/__queue', {
            method: 'POST',
            headers: queueHeaders,
            body,
          }),
        );
      }

      if (!res.ok) {
        // Preserve observability: dispatch tail ingests this under the
        // __platform-dispatch project key so operators can query who is
        // rejecting relays and why.
        let snippet = '';
        try {
          snippet = (await res.clone().text()).slice(0, 200);
        } catch {
          /* body may be unreadable — status alone is still useful */
        }
        console.error(
          `[queue-relay] relay failed queue="${queueName}" worker="${workerName}" status=${res.status} body=${JSON.stringify(snippet)}`,
        );
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
        if (result.ok !== false) {
          batch.ackAll();
        } else {
          batch.retryAll();
        }
        return;
      }

      // Apply per-message decisions
      const msgMap = new Map(batch.messages.map((m) => [m.id, m]));
      for (const [id, decision] of Object.entries(result.decisions)) {
        const cfMsg = msgMap.get(id);
        if (!cfMsg) {
          continue;
        }
        if (decision.action === 'ack') {
          cfMsg.ack();
        } else if (decision.action === 'retry') {
          cfMsg.retry(
            decision.delaySeconds != null ? { delaySeconds: decision.delaySeconds } : undefined,
          );
        }
      }

      // Undecided messages: if handler failed, retry all (individual decisions survive per CF)
      if (result.ok === false) {
        batch.retryAll();
      }
      // If ok=true, undecided messages get implicit ack (CF default on successful consumer return)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[queue-relay] relay threw queue="${queueName}" worker="${workerName}" error=${JSON.stringify(msg)}`,
      );
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Fetch a static asset from KV (small files) or R2 (large files, prefixed with `!`).
 * Tries the project-scoped key first (`assets/{projectId}/{hash}`), then falls back
 * to the legacy shared key (`assets/{hash}`) for backward compatibility with
 * deployments created before asset key scoping was introduced.
 * Returns null if the asset is not found.
 */
async function fetchStaticAsset(
  env: Env,
  hash: string,
  path: string,
  projectId?: string,
): Promise<Response | null> {
  const isLarge = hash.startsWith('!');
  const cleanHash = isLarge ? hash.slice(1) : hash;
  const scopedKey = projectId ? `assets/${projectId}/${cleanHash}` : null;
  const legacyKey = `assets/${cleanHash}`;

  if (isLarge) {
    // Try scoped key first, then legacy
    const obj = scopedKey
      ? ((await env.STATIC_ASSETS_R2.get(scopedKey)) ?? (await env.STATIC_ASSETS_R2.get(legacyKey)))
      : await env.STATIC_ASSETS_R2.get(legacyKey);
    if (!obj) {
      return null;
    }
    const ct = obj.httpMetadata?.contentType ?? getContentType(path);
    const headers: HeadersInit = {
      ETag: obj.httpEtag,
      ...(obj.size ? { 'Content-Length': String(obj.size) } : {}),
    };
    // "application/null" is a sentinel meaning "no Content-Type header" (matches Wrangler)
    if (ct && ct !== 'application/null') {
      (headers as Record<string, string>)['Content-Type'] = ct;
    }
    return new Response(obj.body, { headers });
  }

  // Try scoped key first, then legacy
  if (scopedKey) {
    const scoped = await env.STATIC_ASSETS.getWithMetadata<{ ct: string }>(scopedKey, {
      type: 'arrayBuffer',
      cacheTtl: 86400,
    });
    if (scoped.value) {
      const contentType = scoped.metadata?.ct ?? getContentType(path);
      const headers: HeadersInit = {
        'Content-Length': String((scoped.value as ArrayBuffer).byteLength),
      };
      if (contentType && contentType !== 'application/null') {
        (headers as Record<string, string>)['Content-Type'] = contentType;
      }
      return new Response(scoped.value, { headers });
    }
  }

  const { value, metadata } = await env.STATIC_ASSETS.getWithMetadata<{ ct: string }>(legacyKey, {
    type: 'arrayBuffer',
    cacheTtl: 86400,
  });
  if (!value) {
    return null;
  }
  const contentType = metadata?.ct ?? getContentType(path);
  const headers: HeadersInit = {
    'Content-Length': String((value as ArrayBuffer).byteLength),
  };
  // "application/null" is a sentinel meaning "no Content-Type header" (matches Wrangler)
  if (contentType && contentType !== 'application/null') {
    (headers as Record<string, string>)['Content-Type'] = contentType;
  }
  return new Response(value, { headers });
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
 * to R2 + HTML edge cache, and populates JSON edge cache from embedded page data.
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
    cleanHeaders.delete('X-VoidPages');
    const cleanRequest = new Request(request.url, {
      method: request.method,
      headers: cleanHeaders,
    });
    const response = await worker.fetch(cleanRequest);
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    const cache = caches.default;
    if (ttl > 0 && response.ok) {
      await writeIsrCache(
        env,
        routing.projectId,
        routing.version ?? 'legacy',
        pathname,
        response,
        ttl,
      );
      // Update HTML edge cache with fresh response
      const headers = new Headers(response.headers);
      headers.set('x-isr-cache', 'HIT');
      headers.set('Cache-Control', `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
      headers.delete('set-cookie');
      headers.delete('x-void-page-data');
      await cache.put(
        cacheKey,
        new Response(response.clone().body, {
          status: response.status,
          headers,
        }),
      );
      await populateJsonEdgeCache(cache, jsonCacheKey, response, ttl, 'HIT');
    } else if (ttl === 0) {
      // Worker permanently opted out — remove stale R2 + edge entries + JSON edge
      await deleteIsrCache(env, routing.projectId, routing.version ?? 'legacy', pathname);
      await cache.delete(cacheKey);
      await cache.delete(jsonCacheKey);
    }
  } catch (err) {
    console.error('ISR revalidation failed:', err);
  }
}

function hasExtension(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf('/') + 1).includes('.');
}

function hasCacheOptOut(response: Response): boolean {
  const cc = response.headers.get('Cache-Control');
  if (!cc) {
    return false;
  }
  return /\b(private|no-store|no-cache)\b/.test(cc);
}
