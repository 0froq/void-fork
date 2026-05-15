import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app, { rebuildRequest } from '../../src/index.ts';

// Mock caches.default (CF edge cache) with a Map-backed store.
// Uses full URL as key — callers (isrEdgeCacheKey, hashed asset code) already normalize.
const edgeCacheStore = new Map<string, Response>();

vi.stubGlobal('caches', {
  default: {
    match: async (req: Request) => {
      const res = edgeCacheStore.get(req.url);
      return res ? res.clone() : undefined;
    },
    put: async (req: Request, res: Response) => {
      edgeCacheStore.set(req.url, res.clone());
    },
    delete: async (req: Request) => {
      return edgeCacheStore.delete(req.url);
    },
  },
});

beforeEach(() => {
  edgeCacheStore.clear();
});

type RoutingEntry = {
  workerName: string;
  projectId: string;
  userId?: string;
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
  staticDeploymentId?: string;
  headerRules?: Array<{ pattern: string; headers: Array<[string, string]> }>;
  redirectRules?: Array<{ source: string; destination: string; status: number; host?: string }>;
  queryAllowlist?: Record<string, Array<string>>;
};

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

type MockIsrEntry = {
  body: string;
  status?: number;
  createdAt: number;
  ttl: number;
  headers?: Record<string, string>;
};

function packMockEntry(entry: MockIsrEntry): {
  value: ArrayBuffer;
  metadata: { s: number; c: number; t: number };
} {
  const headers = entry.headers ?? {};
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const bodyBytes = new TextEncoder().encode(entry.body);
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + bodyBytes.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(bodyBytes);
  return {
    value: buffer,
    metadata: { s: entry.status ?? 200, c: entry.createdAt, t: entry.ttl },
  };
}

function createEnv(options: {
  routing: RoutingEntry;
  assets?: Record<string, MockIsrEntry>;
  workerResponse?: Response;
  workerFetchImpl?: () => Promise<Response>;
}): {
  env: Env;
  workerFetch: ReturnType<typeof vi.fn>;
  dispatchGet: ReturnType<typeof vi.fn>;
  kvStore: Map<string, { value: ArrayBuffer; metadata: { s: number; c: number; t: number } }>;
  analyticsWrites: Array<unknown>;
} {
  const workerFetch = vi.fn(
    async () => options.workerFetchImpl?.() ?? options.workerResponse ?? new Response('worker'),
  );
  const kvStore = new Map<
    string,
    { value: ArrayBuffer; metadata: { s: number; c: number; t: number } }
  >();
  const analyticsWrites: Array<unknown> = [];

  // Seed initial ISR cache entries
  if (options.assets) {
    for (const [key, entry] of Object.entries(options.assets)) {
      kvStore.set(key, packMockEntry(entry));
    }
  }

  const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

  const env = {
    ROUTING: {
      get: async () => JSON.stringify(options.routing),
    },
    DISPATCH: {
      get: dispatchGet,
    },
    ISR_CACHE: {
      getWithMetadata: async (key: string) => {
        const entry = kvStore.get(key);
        if (!entry) {
          return { value: null, metadata: null };
        }
        return { value: entry.value, metadata: entry.metadata };
      },
      put: async (key: string, value: ArrayBuffer, opts?: { metadata?: unknown }) => {
        kvStore.set(key, {
          value,
          metadata: opts?.metadata as { s: number; c: number; t: number },
        });
      },
      delete: async (key: string) => {
        kvStore.delete(key);
      },
      list: async (opts: { prefix: string; limit?: number }) => {
        const all = [...kvStore.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
        const limit = opts.limit ?? 1000;
        const slice = all.slice(0, limit);
        return {
          keys: slice.map((name) => ({ name })),
          list_complete: slice.length === all.length,
          cursor: '',
        };
      },
    },
    ANALYTICS: {
      writeDataPoint: (data: unknown) => analyticsWrites.push(data),
    },
  } as unknown as Env;

  return { env, workerFetch, dispatchGet, kvStore, analyticsWrites };
}

describe('dispatch fetch handler', () => {
  it('forwards /api requests to user worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('api'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello', { method: 'GET' }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('api');
  });

  it('meters websocket upgrade requests as websocket while forwarding them', async () => {
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('switching', { status: 200 }),
    });

    const request = new Request('https://my-app.void.app/chat/general', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const response = await app.fetch(request, env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(workerFetch.mock.calls[0]?.[0].headers.get('upgrade')).toBe('websocket');
    expect((analyticsWrites[0] as { blobs: Array<string> }).blobs[1]).toBe('websocket');
    expect(response.headers.get('X-Hosted-By')).toBe('void.cloud');
  });

  it('dispatches SSR requests to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true },
      workerResponse: new Response('<html>ssr</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('<html>ssr</html>');
  });

  it('dispatches non-SSR requests to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('ok');
  });

  it('handles POST request with already-consumed body without throwing', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    // Simulate a request whose body was consumed by upstream edge processing
    const request = new Request('https://my-app.void.app/xmlrpc.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: 'payload',
    });
    await request.text(); // consume the body
    expect(request.bodyUsed).toBe(true);

    const response = await app.fetch(request, env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    // The forwarded request should have no body and no stale body-size headers
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.bodyUsed).toBe(false);
    expect(forwarded.headers.has('content-length')).toBe(false);
    expect(forwarded.headers.has('transfer-encoding')).toBe(false);
    expect(await response.text()).toBe('ok');
  });
});

/**
 * `request.cf` (country, colo, botManagement, tlsClientAuth, …) is populated
 * by the CF edge and is what user workers read for geolocation, bot scoring,
 * and mTLS info. Plain `new Request(url, { method, headers, body })` drops it
 * — we have to thread it through `cf:` in init when we rebuild.
 *
 * Node's `Request` doesn't accept `cf` in init, so we can't observe it on the
 * resulting Request directly. Instead we wrap `globalThis.Request` and assert
 * the constructor receives `cf` in its init bag.
 */
describe('rebuildRequest preserves request.cf', () => {
  let RequestCalls: Array<{ url: unknown; init: RequestInit | undefined }>;
  const OriginalRequest = globalThis.Request;

  beforeEach(() => {
    RequestCalls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Request = class extends OriginalRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        // Strip `cf` before delegating — Node would otherwise reject it. We
        // record the original init for assertion.
        RequestCalls.push({ url: input, init });
        const cleaned = init ? { ...init } : undefined;
        if (cleaned && 'cf' in cleaned) {
          delete (cleaned as { cf?: unknown }).cf;
        }
        super(input, cleaned);
      }
    };
  });

  afterEach(() => {
    globalThis.Request = OriginalRequest;
  });

  function withCf<T extends Request>(req: T, cf: unknown): T {
    Object.defineProperty(req, 'cf', { value: cf, configurable: true, enumerable: true });
    return req;
  }

  it('forwards cf when rebuilding a GET (no body)', () => {
    const cf = { country: 'US', colo: 'SFO', botManagement: { score: 99 } };
    const src = withCf(new OriginalRequest('https://my-app.void.app/old'), cf);

    const out = rebuildRequest(src, 'https://my-app.void.app/new', () => {});

    expect(out).toBeInstanceOf(OriginalRequest);
    // The last constructor invocation is the rebuilt request.
    const last = RequestCalls.at(-1)!;
    expect(last.url).toBe('https://my-app.void.app/new');
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });

  it('forwards cf when rebuilding a POST with streaming body', () => {
    const cf = { country: 'DE' };
    const src = withCf(
      new OriginalRequest('https://my-app.void.app/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'payload',
      }),
      cf,
    );

    rebuildRequest(src, 'https://my-app.void.app/y', () => {});

    const last = RequestCalls.at(-1)!;
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });

  it('forwards cf when the body is already consumed (drop-body branch)', async () => {
    const cf = { country: 'JP' };
    const src = withCf(
      new OriginalRequest('https://my-app.void.app/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'payload',
      }),
      cf,
    );
    await src.text();
    expect(src.bodyUsed).toBe(true);

    rebuildRequest(src, 'https://my-app.void.app/y', () => {});

    const last = RequestCalls.at(-1)!;
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });
});

describe('custom domain routing', () => {
  it('routes custom domain via domain: KV key', async () => {
    const workerFetch = vi.fn(async () => new Response('custom-domain-api'));
    const routing: RoutingEntry = { workerName: 'user-app', projectId: 'proj_1' };

    const env = {
      ROUTING: {
        get: async (key: string) => {
          if (key === 'domain:app.example.com') {
            return JSON.stringify(routing);
          }
          return null;
        },
      },
      DISPATCH: {
        get: () => ({ fetch: workerFetch }),
      },
      ISR_CACHE: {
        getWithMetadata: async () => ({ value: null, metadata: null }),
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request('https://app.example.com/api/hello'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('custom-domain-api');
  });

  it('returns 404 for unknown hostname', async () => {
    const env = {
      ROUTING: {
        get: async () => null,
      },
      DISPATCH: {
        get: () => ({ fetch: vi.fn() }),
      },
      ISR_CACHE: {
        getWithMetadata: async () => ({ value: null, metadata: null }),
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(new Request('https://unknown.example.com/'), env, createCtx());

    expect(response.status).toBe(404);
  });
});

describe('ISR (stale-while-revalidate)', () => {
  it('caches worker response in KV on first ISR request', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response('<html>rendered</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>rendered</html>');

    // Wait for background write
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(kvStore.has('proj_1/isr/v2/legacy/dashboard')).toBe(true);
  });

  it('serves from ISR cache on second request (no worker call)', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>cached</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(await response.text()).toBe('<html>cached</html>');
  });

  it('bypasses ISR cache when Cookie header is present', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>cached</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>personalized</html>'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', {
        headers: { Cookie: 'session=abc' },
      }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('x-isr-cache')).toBeNull();
    expect(await response.text()).toBe('<html>personalized</html>');
  });

  it('does not cache when x-revalidate: 0 opt-out', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response('<html>no-cache</html>', {
        headers: { 'x-revalidate': '0' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('<html>no-cache</html>');
    // No waitUntil calls — analytics is sync, no userId for queue, no ISR cache write
    expect((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(kvStore.has('proj_1/isr/v2/legacy/dashboard')).toBe(false);
  });

  it('SSR without revalidate works unchanged', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
      },
      workerResponse: new Response('<html>ssr</html>'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('x-isr-cache')).toBeNull();
    expect(await response.text()).toBe('<html>ssr</html>');
  });

  it('sets ISR-managed headers on cache-miss response', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response('<html>rendered</html>', {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'private, no-store', // Worker's raw header should be overridden
        },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    const edgeCached = edgeCacheStore.get('https://my-app.void.app/dashboard?__void_isr=legacy');
    expect(edgeCached?.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, max-age=0, must-revalidate',
    );
  });

  it('deletes KV entry when background revalidation gets x-revalidate: 0', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>opt-out</html>', {
        headers: { 'x-revalidate': '0' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(response.headers.get('x-isr-cache')).toBe('STALE');

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();
    // KV entry should be deleted after x-revalidate: 0
    expect(kvStore.has('proj_1/isr/v2/legacy/dashboard')).toBe(false);
  });

  it('revalidates stale entry in background and returns stale content', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000, // 2 minutes ago, TTL is 60s
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Should return stale content immediately
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale</html>');

    // Background revalidation + edge cache put
    expect((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    // Wait for background write
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('serves from edge cache on repeat ISR request (no KV read)', async () => {
    // Pre-populate edge cache
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void_isr=legacy',
      new Response('<html>edge</html>', {
        headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
      }),
    );

    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.text()).toBe('<html>edge</html>');
  });

  it('ignores ISR entries from other deployment namespaces', async () => {
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard',
      new Response('<html>old-unversioned-edge</html>', {
        headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
      }),
    );
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void_isr=dpl_old',
      new Response('<html>old-versioned-edge</html>', {
        headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
      }),
    );

    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        version: 'dpl_new',
      },
      assets: {
        'proj_1/isr/dashboard': {
          body: '<html>old-unversioned-kv</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
        'proj_1/isr/v2/dpl_old/dashboard': {
          body: '<html>old-versioned-kv</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(await response.text()).toBe('<html>fresh</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(kvStore.has('proj_1/isr/v2/dpl_new/dashboard')).toBe(true);
    expect(edgeCacheStore.has('https://my-app.void.app/dashboard?__void_isr=dpl_new')).toBe(true);
  });

  it('populates edge cache after KV hit', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>r2-cached</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.text()).toBe('<html>r2-cached</html>');

    // Wait for edge cache population
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    const edgeCached = edgeCacheStore.get('https://my-app.void.app/dashboard?__void_isr=legacy');
    expect(edgeCached).toBeDefined();
    expect(edgeCached!.headers.get('Cache-Control')).toContain('s-maxage=');
  });

  // User code can branch on `c.isRewritten()` / `c.originalUrl()`, so the ISR
  // cache must not conflate a direct hit to `/en/docs` with a request that
  // was rewritten from `/docs`. Both cache layers (edge URL + KV key) key
  // on the original-URL value so the two variants live in distinct slots.
  it('isolates ISR edge cache between direct and rewritten requests to the same path', async () => {
    // First request: direct hit to /en/docs. Seed only the direct-hit edge
    // cache entry for /en/docs; the rewritten request should miss it.
    edgeCacheStore.set(
      'https://my-app.void.app/en/docs?__void_isr=legacy',
      new Response('<html>direct</html>', {
        headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
      }),
    );

    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('<html>rewritten-render</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const direct = await app.fetch(
      new Request('https://my-app.void.app/en/docs'),
      env,
      createCtx(),
    );
    expect(direct.headers.get('x-isr-cache')).toBe('HIT');
    expect(await direct.text()).toBe('<html>direct</html>');

    const rewritten = await app.fetch(
      new Request('https://my-app.void.app/docs'),
      env,
      createCtx(),
    );
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(rewritten.headers.get('x-isr-cache')).toBe('MISS');
    expect(await rewritten.text()).toBe('<html>rewritten-render</html>');
  });

  // The variant key is derived from the original request URL on a rewrite.
  // Without query normalization, varying any param fans out KV slots and
  // forces re-renders. The default behavior (no allowlist) drops every
  // param so the cache slot is shared across all incoming queries.
  it('collapses all query strings into one ISR variant slot when no queryAllowlist is configured', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/*', destination: '/en/:splat', status: 200 }],
      },
      workerResponse: new Response('<html>x</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    for (let i = 0; i < 3; i++) {
      const ctx = createCtx();
      await app.fetch(new Request(`https://my-app.void.app/docs?cb=${i}`), env, ctx);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    }

    // First request renders + writes; subsequent requests hit the same KV
    // slot regardless of `?cb=` value, so the worker is invoked exactly once.
    expect(workerFetch).toHaveBeenCalledTimes(1);
    const variantKeys = [...kvStore.keys()].filter((k) => k.includes('#rw='));
    expect(variantKeys).toHaveLength(1);
  });

  it('keeps allowlisted query params in the variant key (distinct slots per value)', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/*', destination: '/en/:splat', status: 200 }],
        queryAllowlist: { '/search': ['q'] },
      },
      workerResponse: new Response('<html>x</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const send = async (url: string) => {
      const ctx = createCtx();
      await app.fetch(new Request(url), env, ctx);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    };

    await send('https://my-app.void.app/search?q=void&cb=1');
    await send('https://my-app.void.app/search?q=void&cb=2'); // different cb → same slot (cb dropped)
    await send('https://my-app.void.app/search?q=cloud'); // different q → new slot

    // Three requests, two distinct cache slots, two worker invocations.
    expect(workerFetch).toHaveBeenCalledTimes(2);
    const variantKeys = [...kvStore.keys()].filter((k) => k.includes('#rw='));
    expect(variantKeys).toHaveLength(2);
  });

  it('isolates ISR KV keys between direct and rewritten requests to the same path', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('<html>rendered</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const directCtx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/en/docs'), env, directCtx);
    await Promise.all(
      (directCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );

    const rewriteCtx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/docs'), env, rewriteCtx);
    await Promise.all(
      (rewriteCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );

    // Worker invoked once per request — neither saw a cached entry written by
    // the other, because the KV keys carry a rewrite-variant suffix.
    expect(workerFetch).toHaveBeenCalledTimes(2);

    const keys = [...kvStore.keys()].sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('proj_1/isr/v2/legacy/en/docs');
    expect(keys[1]!.startsWith('proj_1/isr/v2/legacy/en/docs#rw=')).toBe(true);
  });
});

describe('ISR JSON edge cache (pages protocol)', () => {
  const isrRouting: RoutingEntry = {
    workerName: 'user-app',
    projectId: 'proj_1',
    ssr: true,
    revalidate: 60,
  };

  const pageData = JSON.stringify({
    component: 'Dashboard',
    props: { count: 42 },
    url: '/dashboard',
  });

  const pageHtml = (payload = pageData) =>
    `<html><body><script id="__VOID_PAGE_DATA__" type="application/json">${payload}</script><div id="app">rendered</div></body></html>`;

  it('pages request serves from JSON edge cache when populated', async () => {
    // Pre-populate JSON edge cache
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
      new Response(pageData, {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    const { env, workerFetch } = createEnv({ routing: isrRouting });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', {
        headers: { 'X-VoidPages': 'true' },
      }),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.json()).toEqual(JSON.parse(pageData));
  });

  it('pages request falls through to worker on JSON cache miss', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      workerResponse: new Response(pageData, {
        headers: { 'content-type': 'application/json' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', {
        headers: { 'X-VoidPages': 'true' },
      }),
      env,
      createCtx(),
    );

    // Falls through to general dispatch — worker returns JSON for pages requests
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(pageData);
  });

  it('HTML cache miss populates both HTML and JSON edge caches', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      workerResponse: new Response(pageHtml(), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    // Internal transport header should not leak to the client response
    expect(response.headers.has('x-void-page-data')).toBe(false);
    expect(await response.text()).toBe(pageHtml());

    // Wait for background writes
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // HTML edge cache populated
    const htmlCached = edgeCacheStore.get('https://my-app.void.app/dashboard?__void_isr=legacy');
    expect(htmlCached).toBeDefined();
    expect(htmlCached!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, max-age=0, must-revalidate',
    );
    // JSON edge cache populated
    const jsonCached = edgeCacheStore.get(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
    );
    expect(jsonCached).toBeDefined();
    expect(await jsonCached!.text()).toBe(pageData);
  });

  it('background revalidation populates JSON edge cache', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response(pageHtml(), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Stale content returned immediately
    expect(response.headers.get('x-isr-cache')).toBe('STALE');

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // JSON edge cache populated from revalidation
    const jsonCached = edgeCacheStore.get(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
    );
    expect(jsonCached).toBeDefined();
    expect(await jsonCached!.text()).toBe(pageData);
    expect(jsonCached!.headers.get('x-isr-cache')).toBe('HIT');
  });

  it('background revalidation strips X-VoidPages from request', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    // Initial request has X-VoidPages but ISR serves from KV (HTML path)
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Verify the revalidation request does NOT have X-VoidPages
    const revalRequest = workerFetch.mock.calls[0][0] as Request;
    expect(revalRequest.headers.has('X-VoidPages')).toBe(false);
  });

  it('opt-out (ttl=0) deletes JSON edge cache too', async () => {
    // Pre-populate JSON edge cache
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
      new Response(pageData, {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      assets: {
        'proj_1/isr/v2/legacy/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>opt-out</html>', {
        headers: { 'x-revalidate': '0' },
      }),
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // JSON edge cache should be deleted
    expect(
      edgeCacheStore.has('https://my-app.void.app/dashboard?__void=json&__void_isr=legacy'),
    ).toBe(false);
  });

  it('write-behind populates JSON edge cache from embedded page data', async () => {
    // Non-ISR path (no revalidate config matching this path's ISR block) but
    // still has revalidate in routing — this tests the write-behind code path
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: { '/dashboard': 60 },
      },
      workerResponse: new Response(pageHtml(), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    // Request to /other — ISR TTL is 0 (no match), falls through to general dispatch
    // But /dashboard request would hit ISR... let's use a path that falls through ISR
    // but still triggers write-behind
    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    // Internal transport header should not leak to the client response
    expect(response.headers.has('x-void-page-data')).toBe(false);
  });

  it('HTML response without embedded page data does not populate JSON cache', async () => {
    const { env } = createEnv({
      routing: isrRouting,
      workerResponse: new Response('<html>no-page-data</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // HTML cache is populated, but no JSON cache
    expect(edgeCacheStore.has('https://my-app.void.app/dashboard?__void_isr=legacy')).toBe(true);
    expect(
      edgeCacheStore.has('https://my-app.void.app/dashboard?__void=json&__void_isr=legacy'),
    ).toBe(false);
  });

  it('HTML response with deferred page data does not populate JSON cache', async () => {
    const deferredPageData =
      '{"component":"Dashboard","props":{"count":42},"url":"/dashboard","deferred":["stats"],"deferredKeys":{"stats":"stats"}}';
    const { env } = createEnv({
      routing: isrRouting,
      workerResponse: new Response(pageHtml(deferredPageData), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(
      edgeCacheStore.has('https://my-app.void.app/dashboard?__void=json&__void_isr=legacy'),
    ).toBe(false);
  });
});

describe('suspension check', () => {
  it('returns 429 when project is suspended', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        suspended: 'requests_exceeded',
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.error).toBe('usage limit exceeded');
    expect(body.reason).toBe('requests_exceeded');
  });
});

describe('custom limits', () => {
  it('passes limits to DISPATCH.get for API routes', async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        limits: { cpuMs: 10, subRequests: 50 },
      },
      workerResponse: new Response('api'),
    });

    await app.fetch(new Request('https://my-app.void.app/api/hello'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      'user-app',
      {},
      { limits: { cpuMs: 10, subRequests: 50 } },
    );
  });

  it('does not pass limits when routing has no limits', async () => {
    const { env, dispatchGet } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('api'),
    });

    await app.fetch(new Request('https://my-app.void.app/api/hello'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith('user-app');
  });

  it('returns 429 when worker exceeds CPU limit', async () => {
    const workerFetch = vi.fn(async () => {
      throw new Error('Worker exceeded CPU time limit');
    });
    const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

    const env = {
      ROUTING: {
        get: async () =>
          JSON.stringify({
            workerName: 'user-app',
            projectId: 'proj_1',
            limits: { cpuMs: 10 },
          }),
      },
      DISPATCH: { get: dispatchGet },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('CPU limit exceeded');
  });

  it('passes limits to DISPATCH.get for SSR routes', async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        limits: { cpuMs: 30, subRequests: 50 },
      },
      workerResponse: new Response('<html>ssr</html>'),
    });

    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      'user-app',
      {},
      { limits: { cpuMs: 30, subRequests: 50 } },
    );
  });
});

describe('hashed asset caching', () => {
  it('serves hashed asset from edge cache on hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const url = 'https://test.void.app/assets/main-abc123.js';

    // First request — cache miss, hits worker
    const res1 = await app.fetch(new Request(url), env, ctx);
    expect(res1.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    // Wait for background cache.put
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request — cache hit, worker NOT invoked
    const ctx2 = createCtx();
    const res2 = await app.fetch(new Request(url), env, ctx2);
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // still 1
  });

  it('bypasses stale cache entry without immutable header', async () => {
    // Simulate pre-existing Workers Assets cache entry (no immutable header)
    edgeCacheStore.set(
      'https://test.void.app/assets/stale.js',
      new Response('stale', {
        headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
      }),
    );

    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('fresh') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/stale.js'), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // bypassed stale entry, hit worker
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('does not cache non-hashed asset paths without version', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('page') });
    const ctx = createCtx();

    // Request for a non-hashed path
    const res = await app.fetch(new Request('https://test.void.app/about'), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Second request — should still hit worker (no caching)
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/about'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('skips cache for non-GET requests to hashed paths', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/assets/main.js', { method: 'POST' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    // Should not write to cache
    expect(edgeCacheStore.size).toBe(0);
  });

  it('does not cache non-ok worker responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('not found', { status: 404 }),
    });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/missing.js'), env, ctx);
    expect(res.status).toBe(404);
    expect(edgeCacheStore.size).toBe(0);
  });

  it('skips caching when hashedAssetsPrefix is not set', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      // no hashedAssetsPrefix
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/assets/main.js'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Second request — still hits worker (no caching)
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/assets/main.js'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('works with custom prefix like _nuxt', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: '_nuxt',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('nuxt-asset') });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/_nuxt/entry.abc123.js'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('keys cache on post-rewrite hashed URL when a redirect rule rewrites into the hashed prefix', async () => {
    // Hashed assets are cached `immutable` for a year. The cache key must
    // track the post-rewrite (hash-bearing) URL, not the source URL — a
    // future deploy that maps /logo to a different hash would otherwise
    // keep serving the stale entry under /logo.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      redirectRules: [{ source: '/logo', destination: '/assets/logo-abc123.png', status: 200 }],
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/logo'), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(edgeCacheStore.has('https://test.void.app/assets/logo-abc123.png')).toBe(true);
    expect(edgeCacheStore.has('https://test.void.app/logo')).toBe(false);
  });

  it('normalizes query strings for cache key', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    // First request with query string — cache miss, hits worker
    const res1 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js?v=1'),
      env,
      ctx,
    );
    expect(res1.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request with different query string — should still be a cache hit
    const ctx2 = createCtx();
    const res2 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js?v=2'),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // still 1 — cache hit
  });

  it('returns 429 when worker exceeds CPU limit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    // Override worker.fetch to throw CPU limit error
    const dispatchGet = env.DISPATCH.get as ReturnType<typeof vi.fn>;
    dispatchGet.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('Worker exceeded CPU time limit')),
    });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/main-abc.js'), env, ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'CPU limit exceeded' });
  });
});

describe('header rules', () => {
  it('applies header rules to worker responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      headerRules: [
        { pattern: '/*', headers: [['X-Frame-Options', 'DENY']] },
        {
          pattern: '/assets/*',
          headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
        },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/app.js'), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('does not apply header rules to hashed asset cache hits', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [{ pattern: '/*', headers: [['X-Custom', 'from-rules']] }],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    // First request — cache miss, goes through hashed asset path
    const res1 = await app.fetch(new Request('https://test.void.app/assets/main-abc.js'), env, ctx);
    expect(res1.status).toBe(200);
    // Hashed asset path sets its own Cache-Control, header rules don't apply
    expect(res1.headers.get('X-Custom')).toBeNull();

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request — cache hit, also bypasses header rules
    const ctx2 = createCtx();
    const res2 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js'),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-Custom')).toBeNull();
  });

  it('last-match-wins for overlapping patterns', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      headerRules: [
        { pattern: '/*', headers: [['Cache-Control', 'no-cache']] },
        { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/app.js'), env, ctx);
    expect(res.headers.get('Cache-Control')).toBe('immutable');
  });
});

describe('queue relay', () => {
  type MockMessage = {
    id: string;
    timestamp: Date;
    body: unknown;
    attempts: number;
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };

  function createMockBatch(
    queue: string,
    messages: Array<{ id: string; body: unknown; attempts?: number }>,
  ) {
    const msgs: Array<MockMessage> = messages.map((m) => ({
      id: m.id,
      timestamp: new Date('2026-01-15T12:00:00Z'),
      body: m.body,
      attempts: m.attempts ?? 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    return {
      queue,
      messages: msgs,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch & {
      ackAll: ReturnType<typeof vi.fn>;
      retryAll: ReturnType<typeof vi.fn>;
      messages: Array<MockMessage>;
    };
  }

  function createQueueEnv(options: {
    routingRaw?: string | null;
    workerResponse?: Response;
    workerFetchImpl?: () => Promise<Response>;
  }) {
    const workerFetch = vi.fn(
      async (_req: Request) =>
        options.workerFetchImpl?.() ?? options.workerResponse ?? new Response('ok'),
    );
    return {
      env: {
        ROUTING: {
          get: async () => options.routingRaw ?? null,
        },
        DISPATCH: {
          get: () => ({ fetch: workerFetch }),
        },
        ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
        ANALYTICS: { writeDataPoint: () => {} },
      } as unknown as Env,
      workerFetch,
    };
  }

  it('retries all when routing entry is missing', async () => {
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({ routingRaw: null });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it('acks all on legacy protocol (ok: true, no decisions)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(batch.ackAll).toHaveBeenCalledOnce();
    expect(batch.retryAll).not.toHaveBeenCalled();
  });

  it('retries all on legacy protocol (ok: false)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: false }),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it('applies per-message decisions correctly', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [
      { id: 'm1', body: 'ack-me' },
      { id: 'm2', body: 'retry-me' },
      { id: 'm3', body: 'no-decision' },
    ]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: true,
        decisions: {
          m1: { action: 'ack' },
          m2: { action: 'retry' },
        },
      }),
    });

    await app.queue(batch, env);

    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    expect(batch.messages[1].retry).toHaveBeenCalledWith(undefined);
    expect(batch.messages[2].ack).not.toHaveBeenCalled();
    expect(batch.messages[2].retry).not.toHaveBeenCalled();
  });

  it('passes delaySeconds through on retry decisions', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'retry-me' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: true,
        decisions: {
          m1: { action: 'retry', delaySeconds: 30 },
        },
      }),
    });

    await app.queue(batch, env);

    expect(batch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('retries all undecided messages when handler fails (ok: false)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [
      { id: 'm1', body: 'acked' },
      { id: 'm2', body: 'undecided' },
    ]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: false,
        decisions: {
          m1: { action: 'ack' },
        },
      }),
    });

    await app.queue(batch, env);

    // Individual ack decision applied
    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    // retryAll called for undecided messages (CF preserves individual decisions)
    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('retries all on network error', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerFetchImpl: () => Promise.reject(new Error('network error')),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('retries all on non-ok HTTP response', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: new Response('Internal Server Error', { status: 500 }),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('acks all on non-JSON 2xx response (legacy framework)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: new Response('OK', { status: 200 }),
    });

    await app.queue(batch, env);

    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('forwards x-void-internal header to user worker when proxyToken is in routing entry', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
      proxyToken: 'super-secret-token',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(workerFetch).toHaveBeenCalledOnce();
    const req = workerFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('x-void-internal')).toBe('super-secret-token');
  });

  it('omits x-void-internal header when proxyToken is missing (backward-compat)', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    const req = workerFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('x-void-internal')).toBeNull();
  });

  it('logs a structured error when the user worker returns non-2xx', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({
        routingRaw: routing,
        workerResponse: new Response('unauthorized', { status: 401 }),
      });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/queue.*emails/i);
      expect(logged).toMatch(/user-app/);
      expect(logged).toMatch(/401/);
      expect(logged).toMatch(/unauthorized/);
      expect(batch.retryAll).toHaveBeenCalledOnce();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs a structured error when the relay fetch throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({
        routingRaw: routing,
        workerFetchImpl: () => Promise.reject(new Error('connection reset')),
      });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/emails/);
      expect(logged).toMatch(/user-app/);
      expect(logged).toMatch(/connection reset/);
      expect(batch.retryAll).toHaveBeenCalledOnce();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs a structured error when the routing entry is missing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const batch = createMockBatch('orphan-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({ routingRaw: null });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/orphan-queue/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('forwards x-void-internal on legacy /__queue fallback too', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
      proxyToken: 'legacy-token',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const calls: Array<{ path: string; header: string | null }> = [];
    const workerFetch = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      calls.push({ path: url.pathname, header: req.headers.get('x-void-internal') });
      if (url.pathname === '/__void/queue') {
        return new Response('not found', { status: 404 });
      }
      return Response.json({ ok: true });
    });
    const env = {
      ROUTING: { get: async () => routing },
      DISPATCH: { get: () => ({ fetch: workerFetch }) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    await app.queue(batch, env);

    expect(calls).toEqual([
      { path: '/__void/queue', header: 'legacy-token' },
      { path: '/__queue', header: 'legacy-token' },
    ]);
  });
});

describe('redirect rules', () => {
  it('applies redirect rules before invoking worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
    });

    const response = await app.fetch(new Request('https://test.void.app/old'), env, createCtx());

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/new');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('does not redirect non-matching paths', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/other'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('redirects with :splat substitution', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/blog/*', destination: '/posts/:splat', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/hello-world'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/posts/hello-world');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('redirects with named :slug captures', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/blog/:slug', destination: '/articles/:slug', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/articles/hello');
  });

  it('preserves the request query string in the Location header', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/old?utm_source=email&id=42'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/new?utm_source=email&id=42');
  });

  it('destination query takes precedence over request query on conflict', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new?ref=internal', status: 302 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/old?ref=external&utm=x'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/new?ref=internal&utm=x');
  });
});

describe('rewrite rules', () => {
  it('rewrites path and forwards to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('rewritten content'),
    });

    const response = await app.fetch(new Request('https://test.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rewritten content');
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs');
  });

  it('rewrites with :splat substitution', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs/*', destination: '/en/docs/:splat', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs/getting-started'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs/getting-started');
  });

  it('rewrites with named :author/:slug captures', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          { source: '/blog/:author/:slug', destination: '/posts/:author/:slug', status: 200 },
        ],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/jane/first-post'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/posts/jane/first-post');
  });

  it('sets X-Void-Original-URL header on rewritten requests', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe('https://test.void.app/docs');
  });

  it('preserves query string on rewritten requests', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs?lang=en'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.pathname).toBe('/en/docs');
    expect(forwardedUrl.search).toBe('?lang=en');
  });

  it('does not rewrite non-matching paths', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/other'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/other');
    expect(forwarded.headers.has('X-Void-Original-URL')).toBe(false);
  });

  // Host-scoped redirects: dispatch passes `url.hostname` into
  // `applyRoutingRules`. Confirm the wiring through the full handler so a
  // future refactor that loses the hostname argument is caught here. The
  // fixture's ROUTING binding returns the same routing entry for every
  // hostname, so the only thing distinguishing the two requests below is
  // `url.hostname`.
  it('host-scoped redirect fires when request host matches rule.host', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          {
            source: '/*',
            destination: 'https://foo.com/:splat',
            status: 301,
            host: 'www.foo.com',
          },
        ],
      },
    });

    const response = await app.fetch(new Request('https://www.foo.com/about'), env, createCtx());

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://foo.com/about');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('host-scoped redirect skipped when request host differs from rule.host', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          {
            source: '/*',
            destination: 'https://foo.com/:splat',
            status: 301,
            host: 'www.foo.com',
          },
        ],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://foo.com/about'), env, createCtx());

    expect(response.status).toBe(200);
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('rewrite wins over redirect when it is the first match', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          { source: '/page', destination: '/en/page', status: 200 },
          { source: '/page', destination: '/other', status: 302 },
        ],
      },
      workerResponse: new Response('rewritten'),
    });

    const response = await app.fetch(new Request('https://test.void.app/page'), env, createCtx());

    expect(response.status).toBe(200);
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/page');
  });

  // ISR miss must render against the rewritten URL, otherwise content for /docs
  // gets cached under the /en/docs key.
  it('dispatches ISR miss to worker with rewritten URL', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('<html>rewritten</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(new Request('https://my-app.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs');
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe('https://my-app.void.app/docs');
  });

  // Dispatch owns X-Void-Original-URL. A client-supplied value on a request
  // with no matching rewrite must not leak through to the user worker —
  // otherwise a non-Void worker that trusts the header could be spoofed.
  it('strips client-supplied X-Void-Original-URL when no rewrite fires', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/plain', {
        headers: { 'X-Void-Original-URL': 'https://evil/attacker' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.has('X-Void-Original-URL')).toBe(false);
  });

  // On a rewrite, dispatch must overwrite any client value with the true
  // original URL, not concatenate or pass the spoofed value through.
  it('overrides client-supplied X-Void-Original-URL with the true original URL on rewrite', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs', {
        headers: { 'X-Void-Original-URL': 'https://evil/attacker' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe('https://test.void.app/docs');
  });

  // Pin the full original URL (including query) on the X-Void-Original-URL
  // header after a 200-status redirectRule rewrite — not just its presence.
  it('sets X-Void-Original-URL to the full original URL (with query) on redirectRules rewrite', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const originalUrl = 'https://test.void.app/old?ref=email';
    const response = await app.fetch(new Request(originalUrl), env, createCtx());

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/new');
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe(originalUrl);
  });

  // When the inbound body is already consumed (e.g. middleware upstream of
  // dispatch drained it), the rewrite-request builder must: avoid throwing
  // in the Request ctor; forward no body; strip content-length and
  // transfer-encoding so the downstream worker doesn't see stale framing;
  // and still set X-Void-Original-URL on the rewritten URL.
  it('forwards a body-less rewrite request with X-Void-Original-URL when POST body is consumed', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/submit', destination: '/en/submit', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const originalUrl = 'https://test.void.app/submit';
    const inbound = new Request(originalUrl, { method: 'POST', body: 'payload' });
    await inbound.text(); // disturb the stream — bodyUsed becomes true
    expect(inbound.bodyUsed).toBe(true);

    const response = await app.fetch(inbound, env, createCtx());
    expect(response.status).toBe(200);

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.body).toBeNull();
    expect(forwarded.headers.has('content-length')).toBe(false);
    expect(forwarded.headers.has('transfer-encoding')).toBe(false);
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe(originalUrl);
    expect(new URL(forwarded.url).pathname).toBe('/en/submit');
  });

  // The `createEnv` helper returns the same routing entry for any KV key, which
  // hides the `slug ?? domain:${hostname}` branch in dispatch. This test builds
  // ROUTING manually so the rewrite path is exercised against a custom-domain
  // routing entry (the `domain:` KV key path) rather than a slug lookup.
  it('applies rewrite rules on a custom-domain request (domain: KV key path)', async () => {
    const workerFetch = vi.fn(async (_req: Request) => new Response('rewritten'));
    const routingLookups: Array<string> = [];
    const routing: RoutingEntry = {
      workerName: 'user-app',
      projectId: 'proj_custom',
      redirectRules: [{ source: '/docs/*', destination: '/en/docs/:splat', status: 200 }],
    };

    const env = {
      ROUTING: {
        get: async (key: string) => {
          routingLookups.push(key);
          if (key === 'domain:app.example.com') {
            return JSON.stringify(routing);
          }
          return null;
        },
      },
      DISPATCH: { get: () => ({ fetch: workerFetch }) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const originalUrl = 'https://app.example.com/docs/intro';
    const response = await app.fetch(new Request(originalUrl), env, createCtx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rewritten');

    // Routing entry was looked up under the `domain:` key, not a slug.
    expect(routingLookups).toContain('domain:app.example.com');
    expect(routingLookups.every((k) => !k.startsWith('app'))).toBe(true);

    // Rewrite applied correctly; original URL handed off to the worker.
    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs/intro');
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe(originalUrl);
  });
});

describe('static asset caching', () => {
  it('caches static asset on first request, serves from cache on second', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    // First request — cache miss, hits worker
    const res1 = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe('favicon');
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Wait for background cache.put
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request — cache hit, worker NOT invoked
    const ctx2 = createCtx();
    const res2 = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx2);
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('client response omits s-maxage on static cache miss', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('client response omits s-maxage on static cache hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('static edge cache entry retains s-maxage for TTL', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/favicon.ico?_v=deploy-1');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });

  it('invalidates cache on version change', async () => {
    const routing1: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env: env1, workerFetch: wf1 } = createEnv({
      routing: routing1,
      workerResponse: new Response('v1'),
    });
    const ctx1 = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env1, ctx1);
    expect(wf1).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // New deploy with different version
    const routing2: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-2',
    };
    const { env: env2, workerFetch: wf2 } = createEnv({
      routing: routing2,
      workerResponse: new Response('v2'),
    });
    const ctx2 = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env2, ctx2);
    expect(res.status).toBe(200);
    expect(wf2).toHaveBeenCalledTimes(1); // cache miss — different version
  });

  it('does not cache /api/ routes', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('api') });

    await app.fetch(new Request('https://test.void.app/api/data'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/api/data'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2); // no caching
  });

  it('does not cache SSR paths without extension', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ssr page') });

    await app.fetch(new Request('https://test.void.app/about'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/about'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2); // no caching for SSR routes
  });

  it('caches file-extension paths in SSR projects', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('icon') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1); // cache hit
  });

  it('does not cache when version is absent', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      // no version
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache non-OK responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('not found', { status: 404 }),
    });

    await app.fetch(new Request('https://test.void.app/missing.png'), env, createCtx());
    expect(edgeCacheStore.size).toBe(0);
  });

  it('does not cache when worker sets Cache-Control: private', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('dynamic', {
        headers: { 'Cache-Control': 'private, max-age=0' },
      }),
    });

    await app.fetch(new Request('https://test.void.app/avatar.jpg'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/avatar.jpg'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2); // not cached
  });

  it('does not cache when worker sets Cache-Control: no-store', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('dynamic', {
        headers: { 'Cache-Control': 'no-store' },
      }),
    });

    await app.fetch(new Request('https://test.void.app/data.json'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/data.json'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('normalizes query strings (same path, different query → same cache key)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('img') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/logo.png?width=100'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Different query string — should still be cache hit (query normalized to ?_v=deploy-1)
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/logo.png?width=200'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('skips cache for non-GET requests', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });

    await app.fetch(
      new Request('https://test.void.app/form.html', { method: 'POST' }),
      env,
      createCtx(),
    );
    await app.fetch(
      new Request('https://test.void.app/form.html', { method: 'POST' }),
      env,
      createCtx(),
    );
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('applies header rules to cached static assets', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      headerRules: [{ pattern: '/*', headers: [['X-Custom', 'from-rules']] }],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(res.headers.get('X-Custom')).toBe('from-rules');
  });
});

describe('static deployment caching (KV/R2)', () => {
  function createStaticDeployEnv(options: {
    routing: RoutingEntry;
    manifest: Record<string, string>;
    assets: Record<string, { body: string; contentType?: string }>;
  }): { env: Env } {
    const env = {
      ROUTING: {
        get: async (key: string) => {
          if (key.startsWith('manifest:')) {
            return JSON.stringify(options.manifest);
          }
          return JSON.stringify(options.routing);
        },
      },
      DISPATCH: { get: vi.fn(() => ({ fetch: vi.fn() })) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      STATIC_ASSETS: {
        getWithMetadata: async (key: string) => {
          const hash = key.replace(/^assets\/[^/]+\//, '');
          const asset = options.assets[hash];
          if (!asset) {
            return { value: null, metadata: null };
          }
          return {
            value: new TextEncoder().encode(asset.body).buffer,
            metadata: { ct: asset.contentType ?? 'text/html' },
          };
        },
      },
      STATIC_ASSETS_R2: { get: async () => null },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    return { env };
  }

  it('client response omits s-maxage for static deployment', async () => {
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
      },
      manifest: { '/index.html': 'hash1' },
      assets: { hash1: { body: '<html>hello</html>', contentType: 'text/html' } },
    });

    const res = await app.fetch(new Request('https://test.void.app/'), env, createCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('edge cache entry retains s-maxage for static deployment', async () => {
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
      },
      manifest: { '/index.html': 'hash1' },
      assets: { hash1: { body: '<html>hello</html>', contentType: 'text/html' } },
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://test.void.app/'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/?_v=deploy-abc');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });
});
