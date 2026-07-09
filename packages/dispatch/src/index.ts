import type { Env } from './env.ts';
import { createErrorResponse } from './error-page.ts';
import { applyHeaderRules, type HeaderRule } from './headers.ts';
import { extractSlug } from './hostname.ts';
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
} from './isr.ts';
import { recordRequest, sendUsageEvent, type RequestType } from './metering.ts';
import { classifyDynamicRequestType, hasExtension } from './request-type.ts';
import { applyRoutingRules, mergeQueryIntoLocation, type RedirectRule } from './routing-rules.ts';
import { resolveStaticPath, resolveAssetContentType, safeDecodePathname } from './static.ts';
import type { AssetConfig } from './static.ts';
import { buildVariantOriginalUrl, type QueryAllowlist } from './variant-key.ts';
import { DispatchTimeoutError, resolveTimeoutMs, withTimeout } from './with-timeout.ts';

type RoutingEntry = Readonly<{
  workerName: string;
  projectId: string;
  userId?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
  headerRules?: ReadonlyArray<HeaderRule>;
  // `redirectRules` fires pre-asset, `fallbackRules` fires post-asset.
  // List identity encodes the pre-vs-post-asset semantic.
  redirectRules?: ReadonlyArray<RedirectRule>;
  fallbackRules?: ReadonlyArray<RedirectRule>;
  // Per-pathname allowlist of query params that are part of the ISR variant
  // key on a rewrite. Default (no entry / no allowlist) drops every param,
  // so an attacker can't fan out the cache by varying `?utm`/`?cb`/etc.
  queryAllowlist?: QueryAllowlist;
  staticDeploymentId?: string;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
}>;

type QueueRoutingEntry = Readonly<{
  workerName: string;
  projectId: string;
  queueName: string;
  // HMAC-signed proxy token matching the user worker's __VOID_PROXY_TOKEN
  // binding. The framework-generated /__void/queue handler rejects relays
  // without a matching `x-void-internal` header with 401. Absent on entries
  // written by older API versions.
  proxyToken?: string;
}>;

const CLIENT_REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

function clientRevalidateResponse(response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
  return res;
}

// Fast body-less response for an operation bounded by `withTimeout` that
// stalled past the budget. `X-Void-Timeout` names the stalled operation for
// observability; 503s advertise a short `Retry-After` so clients back off.
function timeoutResponse(status: number, label: string): Response {
  return new Response(null, {
    status,
    headers: {
      'X-Void-Timeout': label,
      ...(status === 503 ? { 'Retry-After': '5' } : {}),
    },
  });
}

export function isEventStreamResponse(response: Response): boolean {
  return (
    response.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim() ===
    'text/event-stream'
  );
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

async function applyWorkerFallbackRules(opts: {
  response: Response;
  worker: { fetch(request: Request): Promise<Response> };
  dispatchReq: Request;
  routing: RoutingEntry;
  pathname: string;
  url: URL;
  originalRequestUrl: string;
  originalUrlHeader?: string;
  originalUrlVariant?: string;
}): Promise<{
  response: Response;
  pathname: string;
  originalUrlVariant?: string;
  applied: boolean;
}> {
  if (opts.response.status !== 404 || !opts.routing.fallbackRules?.length) {
    return {
      response: opts.response,
      pathname: opts.pathname,
      originalUrlVariant: opts.originalUrlVariant,
      applied: false,
    };
  }
  if (opts.routing.type === 'void' && opts.response.headers.get('X-Void-No-Match') !== '1') {
    return {
      response: opts.response,
      pathname: opts.pathname,
      originalUrlVariant: opts.originalUrlVariant,
      applied: false,
    };
  }

  const fallback = applyRoutingRules(opts.pathname, opts.routing.fallbackRules, opts.url.hostname);
  if (fallback?.type !== 'rewrite') {
    return {
      response: opts.response,
      pathname: opts.pathname,
      originalUrlVariant: opts.originalUrlVariant,
      applied: false,
    };
  }

  const fallbackHeader = opts.originalUrlHeader ?? opts.originalRequestUrl;
  const originalUrlVariant =
    opts.originalUrlVariant ??
    buildVariantOriginalUrl(opts.originalRequestUrl, opts.pathname, opts.routing.queryAllowlist);
  const fallbackUrl = new URL(opts.url.toString());
  fallbackUrl.pathname = fallback.destination;
  const fallbackRequest = rebuildRequest(opts.dispatchReq, fallbackUrl.toString(), (headers) =>
    headers.set('X-Void-Original-URL', fallbackHeader),
  );

  return {
    response: await opts.worker.fetch(fallbackRequest),
    pathname: fallback.destination,
    originalUrlVariant,
    applied: true,
  };
}

function buildFallbackOriginalUrlVariant(
  requestUrl: string,
  pathname: string,
  requestHost: string,
  routing: RoutingEntry,
  originalUrlVariant: string | undefined,
): string | undefined {
  // Fallback rewrites are discovered after the first worker/static miss, but
  // ISR needs the read key before dispatching. If a fallback rule can handle
  // this pathname, use the same original-URL variant a later fallback dispatch
  // would expose via X-Void-Original-URL so query-allowlisted renders cannot
  // collide with the direct ISR key.
  if (originalUrlVariant || !routing.fallbackRules?.length) {
    return originalUrlVariant;
  }
  const fallback = applyRoutingRules(pathname, routing.fallbackRules, requestHost);
  if (fallback?.type !== 'rewrite') {
    return undefined;
  }
  return buildVariantOriginalUrl(requestUrl, pathname, routing.queryAllowlist);
}

// CF's error text for WC-4511 asset dedupe poisoning. Not guaranteed
// stable — monitor fallback telemetry if CF's worker-runtime changes.
const CF_ASSETS_STUB_MARKER = 'Assets have not yet been deployed to this script';

function isLikelyCfAssetStub(response: Response): boolean {
  if (response.status !== 200) {
    return false;
  }
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (!contentType?.startsWith('text/plain')) {
    return false;
  }
  const contentLengthRaw = response.headers.get('content-length');
  if (!contentLengthRaw) {
    return false;
  }
  const contentLength = Number.parseInt(contentLengthRaw, 10);
  return contentLength > 0 && contentLength < 200;
}

// Serve the requested asset from platform R2/KV using the mirror written
// on deploy. Returns null if the routing entry lacks a manifest, the
// manifest is missing from KV, or the path/hash cannot be resolved — in
// which case the caller should pass through the original response.
async function serveWfpAssetFallback(
  env: Env,
  routing: RoutingEntry,
  pathname: string,
): Promise<Response | null> {
  if (!routing.assetManifestId) {
    return null;
  }
  const manifestRaw = await env.ROUTING.get(`manifest:${routing.assetManifestId}`, {
    cacheTtl: 86400,
  });
  if (!manifestRaw) {
    return null;
  }
  const assetManifest: Record<string, string> = JSON.parse(manifestRaw);
  const assetConfig: AssetConfig = routing.assetConfig ?? { not_found_handling: 'none' };
  const resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
  if (!resolved) {
    return null;
  }
  if (resolved.redirect) {
    return new Response(null, {
      status: 308,
      headers: { Location: resolved.redirect },
    });
  }
  const assetResponse = await fetchStaticAsset(
    env,
    resolved.hash,
    resolved.path,
    routing.projectId,
  );
  if (!assetResponse) {
    return null;
  }
  return new Response(assetResponse.body, {
    status: resolved.notFound ? 404 : 200,
    headers: assetResponse.headers,
  });
}

function logWfpAssetFallback(
  routing: RoutingEntry,
  pathname: string,
  userAgent: string | null,
): void {
  console.log(
    JSON.stringify({
      event: 'wfp-asset-fallback',
      projectId: routing.projectId,
      deploymentId: routing.assetManifestId,
      pathname,
      userAgent,
      ts: Date.now(),
    }),
  );
}

async function maybeServeWfpAssetFallback(opts: {
  env: Env;
  routing: RoutingEntry;
  pathname: string;
  response: Response;
  userAgent: string | null;
}): Promise<Response> {
  if (isEventStreamResponse(opts.response)) {
    return opts.response;
  }
  if (!opts.routing.assetManifestId || !isLikelyCfAssetStub(opts.response)) {
    return opts.response;
  }
  const body = await opts.response.clone().text();
  if (!body.includes(CF_ASSETS_STUB_MARKER)) {
    return opts.response;
  }
  const fallback = await serveWfpAssetFallback(opts.env, opts.routing, opts.pathname);
  if (!fallback) {
    return opts.response;
  }
  logWfpAssetFallback(opts.routing, opts.pathname, opts.userAgent);
  return fallback;
}

/**
 * Rebuild a `Request` with mutated headers, optionally under a new URL.
 * Handles the body-preservation cases we hit at three points in the fetch
 * handler (ingress header-strip, rewrite URL swap, post-ISR dispatch):
 *
 * - Body already consumed/locked: drop body and any stale framing headers
 *   (`content-length` / `transfer-encoding`) — some runtimes reject bodiless
 *   frames that still advertise a framing size.
 * - GET / HEAD: no body to forward; skip the body + duplex dance.
 * - Everything else: forward the streaming body with `duplex: 'half'`.
 */
export function rebuildRequest(
  request: Request,
  url: string,
  mutateHeaders: (headers: Headers) => void,
): Request {
  const headers = new Headers(request.headers);
  mutateHeaders(headers);
  // `cf` (country, colo, botManagement, tlsClientAuth, …) is populated by
  // the CF edge and read by user workers. A plain `new Request(url, init)`
  // does not propagate it; we have to thread it through init.cf explicitly.
  const cfProperties = request.cf;
  if (request.bodyUsed || request.body?.locked) {
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    return new Request(url, { method: request.method, headers, cf: cfProperties });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Request(url, { method: request.method, headers, cf: cfProperties });
  }
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    cf: cfProperties,
    // @ts-expect-error -- duplex required for streaming bodies in CF Workers
    duplex: 'half',
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);
    // Budget for the bounded hot paths (static-asset reads, primary dispatch).
    // Unset → the 10s default. An explicit `0`/negative/non-finite override is
    // passed through verbatim, disabling the timers via `withTimeout`'s escape
    // hatch (any non-positive/non-finite value = "no timer") — an operator kill
    // switch that works WITHOUT a redeploy.
    const timeoutMs = resolveTimeoutMs(env.DISPATCH_TIMEOUT_MS);

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

    // Strip any client-supplied X-Void-Original-URL on entry. Dispatch owns this
    // header: the only legitimate source is a dispatch-side rewrite below, which
    // sets it on `workerRequest` with the true original URL. Allowing a client
    // value to flow through would let callers spoof the "original URL" seen by
    // user workers that trust the header.
    if (request.headers.has('X-Void-Original-URL')) {
      request = rebuildRequest(request, request.url, (headers) =>
        headers.delete('X-Void-Original-URL'),
      );
    }
    let pathname = url.pathname;
    let requestType: RequestType =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? 'websocket' : 'static';

    const meter = (response: Response) => {
      const responseBytes = isEventStreamResponse(response)
        ? 0
        : Number(response.headers.get('content-length') ?? 0);
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
      res.headers.delete('X-Void-No-Match');
      res.headers.set('X-Hosted-By', 'void.cloud');
      return res;
    };

    // Routing rules — redirects short-circuit, rewrites modify pathname
    // Two distinct values flow out of a rewrite:
    //   - `originalUrlVariant`: feeds the ISR variant key. Normalized via
    //     `routing.queryAllowlist` so an attacker can't fan out cache slots
    //     by varying `?utm`/`?cb`/etc.
    //   - `originalUrlHeader`: the X-Void-Original-URL surfaced to user
    //     workers for `c.originalUrl()`. Carries the full request URL —
    //     user code expects to see the actual URL the client sent.
    let originalUrlVariant: string | undefined;
    let originalUrlHeader: string | undefined;
    if (routing.redirectRules?.length) {
      const result = applyRoutingRules(pathname, routing.redirectRules, url.hostname);
      if (result?.type === 'redirect') {
        const location = mergeQueryIntoLocation(result.destination, url.search);
        return meter(
          new Response(null, { status: result.status, headers: { Location: location } }),
        );
      }
      if (result?.type === 'rewrite') {
        // Destination shape (path-absolute, no `//`, no `?`) is enforced by
        // the framework validator and re-checked by the API on manifest ingest
        // (see `packages/api/src/routes/deploy.ts`). Dispatch trusts those two
        // gates and does not re-validate here.
        originalUrlHeader = request.url;
        originalUrlVariant = buildVariantOriginalUrl(request.url, pathname, routing.queryAllowlist);
        pathname = result.destination;
        url.pathname = pathname;
      }
    }

    // If rewritten, build the request the worker + ISR should see (rewritten
    // URL + original-URL header).
    let workerRequest = request;
    if (originalUrlHeader) {
      workerRequest = rebuildRequest(request, url.toString(), (headers) =>
        headers.set('X-Void-Original-URL', originalUrlHeader),
      );
    }

    // Edge-cache hashed static assets (immutable, content-addressed URLs)
    if (request.method === 'GET' && routing.hashedAssetsPrefix) {
      const prefix = '/' + routing.hashedAssetsPrefix + '/';
      if (pathname.startsWith(prefix)) {
        // Cache key tracks the post-rewrite (hash-bearing) URL, not the
        // request URL: hashed entries are stored with a 1-year immutable
        // Cache-Control, so a redirect rule that maps a stable path like
        // /logo to /assets/logo-<hash>.png must not cache content under
        // /logo — a future deploy that points /logo at a different hash
        // would keep serving the stale entry. Strip query: hashed
        // filenames are already content-addressed by their pathname.
        const cacheUrl = new URL(url.toString());
        cacheUrl.search = '';
        const cacheKey = new Request(cacheUrl.toString());

        // Hashed assets are served straight from the immutable edge cache. Apply
        // routing.headerRules on the way OUT — on both cache HIT and MISS — instead
        // of baking them into the cached body. This is what lets a cross-origin
        // isolated app put COOP/COEP/CORP on its hashed worker/wasm assets: browsers
        // fetch those over GET, and without per-serve header application the GET
        // response (unlike a HEAD, which falls through to the worker and is handled
        // by the dispatch path's applyHeaderRules) would ship with no COEP, so a
        // module worker spawned from a require-corp document would be blocked.
        // Applying per-serve rather than at cache-write also means a header-rule
        // change in a later deploy takes effect even when the content hash — and
        // thus the unversioned, immutable cache key — is unchanged.
        //
        // Tenant rules apply ADDITIVELY only. The platform/origin owns how a
        // content-addressed asset is cached, represented, and framed on the wire;
        // tenants may ADD headers (COOP/COEP/CORP, security) but must not rewrite
        // the headers below, so each is restored from the pre-rule response after
        // the rules run. The set is exactly the headers whose forgery would corrupt
        // the asset or break the immutable-cache / usage-metering contract:
        //   cache-control     immutable contract; the cache-HIT check above keys on it
        //   content-type      wrong MIME breaks ES-module / WebAssembly loading
        //   content-encoding  a false `gzip` makes the browser mis-decode the bytes
        //   content-length    meter() bills from it; clients frame the body by it
        //   content-range     } forging range/framing semantics truncates or
        //   accept-ranges     } mis-reads a body the platform did not range-encode
        //   transfer-encoding hop-by-hop framing; must never come from a tenant rule
        // Cosmetic metadata (Vary, ETag, ...) is left overridable — on an immutable
        // URL-keyed asset it is neither a corruption nor a security risk. This
        // mirrors how the static-asset paths force their own Cache-Control after
        // applyHeaderRules via clientRevalidateResponse.
        const MANAGED_ASSET_HEADERS = [
          'cache-control',
          'content-type',
          'content-encoding',
          'content-length',
          'content-range',
          'accept-ranges',
          'transfer-encoding',
        ] as const;
        const finalizeAsset = (assetResponse: Response): Response => {
          const ruled = applyHeaderRules(assetResponse, pathname, routing.headerRules);
          // applyHeaderRules returns the same object when nothing matched — then
          // there is no override to undo and we can skip the header restore.
          if (ruled !== assetResponse) {
            for (const name of MANAGED_ASSET_HEADERS) {
              const managed = assetResponse.headers.get(name);
              if (managed === null) {
                ruled.headers.delete(name);
              } else {
                ruled.headers.set(name, managed);
              }
            }
          }
          return meter(ruled);
        };

        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached?.headers.get('Cache-Control')?.includes('immutable')) {
          return finalizeAsset(cached);
        }
        // Cache miss — fetch from KV/R2 for static deployments, or invoke worker
        if (routing.staticDeploymentId) {
          const manifestRaw = await env.ROUTING.get(`manifest:${routing.staticDeploymentId}`, {
            cacheTtl: 86400,
          });
          const assetManifest: Record<string, string> = manifestRaw ? JSON.parse(manifestRaw) : {};
          // Manifest keys are decoded on-disk paths, but `pathname` stays
          // percent-encoded. Try the raw key, then the decoded key (e.g. a
          // hashed file named `oxc masthead.riv` requested as `oxc%20masthead.riv`).
          let assetPath = pathname;
          let hash = assetManifest[pathname];
          if (!hash) {
            const decoded = safeDecodePathname(pathname);
            if (decoded !== pathname && assetManifest[decoded]) {
              assetPath = decoded;
              hash = assetManifest[decoded];
            }
          }
          let response: Response;
          if (hash) {
            try {
              response =
                (await withTimeout(
                  fetchStaticAsset(env, hash, assetPath, routing.projectId),
                  timeoutMs,
                  'static-asset',
                )) ?? createErrorResponse(request, 404, 'Not Found');
            } catch (err) {
              // No `resolved.notFound` in scope on this hashed-asset branch — a
              // stalled read is always a real asset read, so fast 503.
              if (err instanceof DispatchTimeoutError) {
                return meter(timeoutResponse(503, 'static-asset'));
              }
              throw err;
            }
          } else {
            response = createErrorResponse(request, 404, 'Not Found');
          }
          if (response.ok && !isEventStreamResponse(response)) {
            const res = new Response(response.body, response);
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return finalizeAsset(res);
          }
          return finalizeAsset(response);
        }
        try {
          const worker = getWorker(env, routing);
          let response = await worker.fetch(workerRequest);
          // Safety net for CF asset dedupe poisoning (WC-4511). See
          // meta/design-docs/0066. Detection only triggers on the CF
          // stub's fingerprint; all other responses stream through.
          response = await maybeServeWfpAssetFallback({
            env,
            routing,
            pathname,
            response,
            userAgent: request.headers.get('user-agent'),
          });
          if (response.ok && !isEventStreamResponse(response)) {
            const res = new Response(response.body, response);
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return finalizeAsset(res);
          }
          return finalizeAsset(response);
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
        const isrOriginalUrlVariant = buildFallbackOriginalUrlVariant(
          request.url,
          pathname,
          url.hostname,
          routing,
          originalUrlVariant,
        );

        // Pages protocol: check JSON edge cache, fall through on miss
        if (isPagesRequest) {
          const jsonCacheKey = isrEdgeCacheKeyJson(
            request,
            pathname,
            isrDeploymentId,
            isrOriginalUrlVariant,
          );
          const jsonCached = await cache.match(jsonCacheKey);
          if (jsonCached) {
            requestType = 'isr';
            return meter(clientRevalidateResponse(jsonCached));
          }
          // Miss — fall through to general dispatch (worker returns JSON for X-VoidPages)
        } else {
          // HTML path: Edge → R2 → Worker
          const cacheKey = isrEdgeCacheKey(
            request,
            pathname,
            isrDeploymentId,
            isrOriginalUrlVariant,
          );
          const jsonCacheKey = isrEdgeCacheKeyJson(
            request,
            pathname,
            isrDeploymentId,
            isrOriginalUrlVariant,
          );

          // L1: Edge cache (per-colo)
          const edgeCached = await cache.match(cacheKey);
          if (edgeCached) {
            requestType = 'isr';
            return meter(clientRevalidateResponse(edgeCached));
          }

          // L2: R2 (global)
          const cached = await readIsrCache(
            env,
            routing.projectId,
            isrDeploymentId,
            pathname,
            isrOriginalUrlVariant,
          );
          if (cached) {
            const stale = isStale(cached);
            if (stale) {
              ctx.waitUntil(
                revalidateInBackground(
                  env,
                  routing,
                  workerRequest,
                  pathname,
                  isrTtl,
                  cacheKey,
                  jsonCacheKey,
                  isrOriginalUrlVariant,
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
          let workerResponse = await worker.fetch(workerRequest);
          let isWorkerEventStream = isEventStreamResponse(workerResponse);
          const cachePathname = pathname;
          const cacheOriginalUrlVariant = isrOriginalUrlVariant;
          const cacheKeyForWrite = cacheKey;
          const jsonCacheKeyForWrite = jsonCacheKey;
          if (!isWorkerEventStream) {
            const fallbackResult = await applyWorkerFallbackRules({
              response: workerResponse,
              worker,
              dispatchReq: workerRequest,
              routing,
              pathname,
              url,
              originalRequestUrl: request.url,
              originalUrlHeader,
              originalUrlVariant: isrOriginalUrlVariant,
            });
            if (fallbackResult.applied) {
              workerResponse = fallbackResult.response;
              isWorkerEventStream = isEventStreamResponse(workerResponse);
              if (!isWorkerEventStream) {
                workerResponse = await maybeServeWfpAssetFallback({
                  env,
                  routing,
                  pathname: fallbackResult.pathname,
                  response: workerResponse,
                  userAgent: request.headers.get('user-agent'),
                });
                isWorkerEventStream = isEventStreamResponse(workerResponse);
              }
            }
          }
          if (isWorkerEventStream) {
            return meter(workerResponse);
          }
          const ttl = resolveRevalidateTtl(workerResponse, isrTtl);
          if (ttl > 0 && workerResponse.ok) {
            ctx.waitUntil(
              writeIsrCache(
                env,
                routing.projectId,
                isrDeploymentId,
                cachePathname,
                workerResponse,
                ttl,
                cacheOriginalUrlVariant,
              ),
            );
            ctx.waitUntil(
              populateJsonEdgeCache(cache, jsonCacheKeyForWrite, workerResponse, ttl, 'MISS'),
            );
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
            ctx.waitUntil(cache.put(cacheKeyForWrite, cacheResponse.clone()));

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

      // Capture pathname before the fallback rewrite potentially mutates it.
      // The edge cache must be keyed on the path seen here (what the client
      // requested, post any pre-asset rewrites), not the rewrite target —
      // otherwise future requests to this path miss the cache entry.
      const fallbackOriginPathname = pathname;
      let resolved = resolveStaticPath(pathname, assetManifest, assetConfig);

      // Fallback rules — fire only when nothing matched in static resolution.
      // Single-pass: re-resolve with rewritten path, no further fallbacks.
      // `fallbackRules` are status-200-only (enforced at API ingest), so
      // `applyRoutingRules` only ever yields `type: 'rewrite'` here.
      if (!resolved && routing.fallbackRules?.length) {
        const fallback = applyRoutingRules(pathname, routing.fallbackRules, url.hostname);
        if (fallback?.type === 'rewrite') {
          // Same trust model as the redirectRules rewrite above — framework +
          // API both validate destination shape before the manifest lands here.
          pathname = fallback.destination;
          url.pathname = pathname;
          resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
        }
      }

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

      let assetResponse: Response | null;
      try {
        assetResponse = await withTimeout(
          fetchStaticAsset(env, resolved.hash, resolved.path, routing.projectId),
          timeoutMs,
          'static-asset',
        );
      } catch (err) {
        // A stalled read of the not-found asset was always going to 404, so
        // return a fast 404 (must not trip the 5xx alert); a real asset read
        // that stalled → fast 503.
        if (err instanceof DispatchTimeoutError) {
          return meter(timeoutResponse(resolved.notFound ? 404 : 503, 'static-asset'));
        }
        throw err;
      }
      if (!assetResponse) {
        return meter(createErrorResponse(request, 404, 'Not Found'));
      }

      const status = resolved.notFound ? 404 : 200;
      const response = new Response(assetResponse.body, {
        status,
        headers: assetResponse.headers,
      });
      const finalRes = applyHeaderRules(response, pathname, routing.headerRules);

      // Populate edge cache (same pattern as existing deploy-versioned static cache).
      // Key on the ORIGINAL pathname the client requested, not the post-fallback
      // rewrite target — otherwise future requests to the original path miss.
      const edgeCacheKey =
        staticCacheKey ??
        (request.method === 'GET'
          ? new Request(`${url.origin}${fallbackOriginPathname}?_v=${routing.staticDeploymentId}`)
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
      let dispatchReq = workerRequest;
      if (dispatchReq.bodyUsed) {
        dispatchReq = rebuildRequest(dispatchReq, dispatchReq.url, () => {});
      }
      // If a worker-backed fallbackRule could fire on a 404, the inner
      // re-dispatch needs the original body — but `worker.fetch` consumes
      // the body stream and `rebuildRequest` on a `bodyUsed` request drops
      // it (silently). Clone here so the fallback path has a replayable
      // copy. `Request.clone()` tees the stream on CF Workers. Skip the
      // clone when there are no fallback rules or the method has no body
      // (GET/HEAD) — the common case stays free.
      const hasBodyMethod = dispatchReq.method !== 'GET' && dispatchReq.method !== 'HEAD';
      const dispatchReqForFallback =
        hasBodyMethod && routing.fallbackRules?.length ? dispatchReq.clone() : dispatchReq;
      let response = await withTimeout(worker.fetch(dispatchReq), timeoutMs, 'dispatch');
      let isEventStream = isEventStreamResponse(response);

      // Safety net for CF asset dedupe poisoning (WC-4511). See
      // meta/design-docs/0066. Pre-check gates body read so non-asset
      // responses stream through untouched.
      if (!isEventStream) {
        response = await maybeServeWfpAssetFallback({
          env,
          routing,
          pathname,
          response,
          userAgent: request.headers.get('user-agent'),
        });
        isEventStream = isEventStreamResponse(response);
      }

      // routing.fallbackRules — for static deployments these fire post-asset
      // (line ~533). The user worker is the equivalent path resolver here, so
      // a 404 is the analogue of a static-asset miss. Single-pass: the
      // rewrite target's response is returned as-is even if it's also 404.
      if (!isEventStream) {
        const fallbackResult = await applyWorkerFallbackRules({
          response,
          worker,
          dispatchReq: dispatchReqForFallback,
          routing,
          pathname,
          url,
          originalRequestUrl: request.url,
          originalUrlHeader,
          originalUrlVariant,
        });
        if (fallbackResult.applied) {
          pathname = fallbackResult.pathname;
          url.pathname = pathname;
          originalUrlVariant = fallbackResult.originalUrlVariant;
          response = fallbackResult.response;
          isEventStream = isEventStreamResponse(response);
          if (!isEventStream) {
            response = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response,
              userAgent: request.headers.get('user-agent'),
            });
            isEventStream = isEventStreamResponse(response);
          }
        }
      }

      // Cache static asset at edge if eligible
      if (staticCacheKey && response.ok && !isEventStream && !hasCacheOptOut(response)) {
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
      const dynamicType = classifyDynamicRequestType(pathname, routing.ssr);
      if (dynamicType) {
        requestType = dynamicType;
      }

      // Write ISR cache on miss — skip pages protocol responses (JSON, not HTML)
      // Guard: only cache GET requests without credentials, and respect worker x-revalidate
      if (
        routing.revalidate &&
        !isEventStream &&
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
            writeIsrCache(
              env,
              routing.projectId,
              isrDeploymentId,
              pathname,
              response,
              isrTtl,
              originalUrlVariant,
            ),
          );
          const jsonCacheKey = isrEdgeCacheKeyJson(
            request,
            pathname,
            isrDeploymentId,
            originalUrlVariant,
          );
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
      if (err instanceof DispatchTimeoutError) {
        const dynamicType = classifyDynamicRequestType(pathname, routing.ssr);
        if (dynamicType) {
          requestType = dynamicType;
        }
        return meter(timeoutResponse(503, 'dispatch'));
      }
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
    const messages = Array.from(batch.messages, (message) => ({
      id: message.id,
      timestamp: message.timestamp.toISOString(),
      body: message.body,
      attempts: message.attempts,
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
      const messageMap = new Map(batch.messages.map((message) => [message.id, message]));
      for (const [id, decision] of Object.entries(result.decisions)) {
        const cfMessage = messageMap.get(id);
        if (!cfMessage) {
          continue;
        }
        if (decision.action === 'ack') {
          cfMessage.ack();
        } else if (decision.action === 'retry') {
          cfMessage.retry(
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
    const contentType = resolveAssetContentType(obj.httpMetadata?.contentType, path);
    const headers: HeadersInit = {
      ETag: obj.httpEtag,
      ...(obj.size ? { 'Content-Length': String(obj.size) } : {}),
    };
    if (contentType) {
      (headers as Record<string, string>)['Content-Type'] = contentType;
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
      const contentType = resolveAssetContentType(scoped.metadata?.ct, path);
      const headers: HeadersInit = {
        'Content-Length': String((scoped.value as ArrayBuffer).byteLength),
      };
      if (contentType) {
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
  const contentType = resolveAssetContentType(metadata?.ct, path);
  const headers: HeadersInit = {
    'Content-Length': String((value as ArrayBuffer).byteLength),
  };
  if (contentType) {
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
  originalUrl?: string | null,
): Promise<void> {
  try {
    const worker = getWorker(env, routing);
    // Strip X-VoidPages so the worker always returns HTML.
    // Use rebuildRequest so request.cf (country/colo/botManagement/tlsClientAuth)
    // survives the rebuild — otherwise the background re-render runs with
    // cf === undefined and writes wrong-geo/wrong-bot HTML into the ISR cache.
    const cleanRequest = rebuildRequest(request, request.url, (headers) =>
      headers.delete('X-VoidPages'),
    );
    let response = await worker.fetch(cleanRequest);
    if (isEventStreamResponse(response)) {
      return;
    }
    const fallbackResult = await applyWorkerFallbackRules({
      response,
      worker,
      dispatchReq: cleanRequest,
      routing,
      pathname,
      url: new URL(cleanRequest.url),
      originalRequestUrl: request.url,
      originalUrlHeader: request.headers.get('X-Void-Original-URL') ?? undefined,
      originalUrlVariant: originalUrl ?? undefined,
    });
    response = fallbackResult.response;
    if (isEventStreamResponse(response)) {
      return;
    }
    response = await maybeServeWfpAssetFallback({
      env,
      routing,
      pathname: fallbackResult.pathname,
      response,
      userAgent: request.headers.get('user-agent'),
    });
    if (isEventStreamResponse(response)) {
      return;
    }
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
        originalUrl,
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
      await deleteIsrCache(
        env,
        routing.projectId,
        routing.version ?? 'legacy',
        pathname,
        originalUrl,
      );
      await cache.delete(cacheKey);
      await cache.delete(jsonCacheKey);
    }
  } catch (err) {
    console.error('ISR revalidation failed:', err);
  }
}

function hasCacheOptOut(response: Response): boolean {
  const cacheControl = response.headers.get('Cache-Control');
  if (!cacheControl) {
    return false;
  }
  return /\b(private|no-store|no-cache)\b/.test(cacheControl);
}
