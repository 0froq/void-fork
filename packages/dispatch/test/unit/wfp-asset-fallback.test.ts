import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import app from '../../src/index';

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
    delete: async (req: Request) => edgeCacheStore.delete(req.url),
  },
});

beforeEach(() => {
  edgeCacheStore.clear();
});

const STUB_BODY = 'Assets have not yet been deployed to this script.\n';

function stubResponse(): Response {
  return new Response(STUB_BODY, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Content-Length': String(STUB_BODY.length),
    },
  });
}

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

interface Harness {
  routing: {
    workerName: string;
    projectId: string;
    userId?: string;
    version?: string;
    assetManifestId?: string;
    assetConfig?: { not_found_handling?: 'none' | 'single-page-application' | '404-page' };
    hashedAssetsPrefix?: string;
  };
  servingManifest?: Record<string, string>;
  staticAssets?: Record<string, { content: ArrayBuffer; ct?: string }>;
  workerResponse: Response | (() => Response);
}

function createEnv(h: Harness): { env: Env; workerFetch: ReturnType<typeof vi.fn> } {
  const workerFetch = vi.fn(async () =>
    typeof h.workerResponse === 'function' ? h.workerResponse() : h.workerResponse,
  );
  const env = {
    ROUTING: {
      get: async (key: string) => {
        if (h.servingManifest && h.routing.assetManifestId === key.replace(/^manifest:/, '')) {
          return JSON.stringify(h.servingManifest);
        }
        if (key.startsWith('manifest:')) {
          return null;
        }
        return JSON.stringify(h.routing);
      },
    },
    DISPATCH: {
      get: () => ({ fetch: workerFetch }),
    },
    STATIC_ASSETS: {
      getWithMetadata: async (key: string) => {
        const asset = h.staticAssets?.[key];
        if (!asset) {
          return { value: null, metadata: null };
        }
        return { value: asset.content, metadata: asset.ct ? { ct: asset.ct } : null };
      },
    },
    STATIC_ASSETS_R2: { get: async () => null },
    ISR_CACHE: {
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async () => {},
      delete: async () => {},
    },
    ANALYTICS: { writeDataPoint: () => {} },
    USAGE_QUEUE: { send: async () => {} },
  } as unknown as Env;
  return { env, workerFetch };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

describe('WfP asset fallback on CF stub', () => {
  it('falls back to mirrored KV asset when worker returns the CF stub', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/logo.png': 'hashxyz' },
      staticAssets: { 'assets/proj_1/hashxyz': { content: PNG_BYTES, ct: 'image/png' } },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = await res.arrayBuffer();
    expect(new Uint8Array(body)).toEqual(new Uint8Array(PNG_BYTES));
  });

  it('passes stub through unchanged when routing lacks assetManifestId', async () => {
    const { env } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(STUB_BODY);
  });

  it('passes stub through when serving manifest is missing from KV', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_missing',
      },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(await res.text()).toBe(STUB_BODY);
  });

  it('passes stub through when the path is not in the serving manifest', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        assetConfig: { not_found_handling: 'none' },
      },
      servingManifest: { '/other.png': 'hashxyz' },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(await res.text()).toBe(STUB_BODY);
  });

  it('passes stub through when mirror bytes are missing from STATIC_ASSETS', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/logo.png': 'hashxyz' },
      staticAssets: {}, // no bytes on hand
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(await res.text()).toBe(STUB_BODY);
  });

  it('does not buffer the body for non-matching responses (large JSON API reply)', async () => {
    const largeBody = JSON.stringify({ items: new Array(100).fill({ x: 1 }) });
    const apiResponse = new Response(largeBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(largeBody.length),
      },
    });
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/api/items': 'hashxyz' },
      staticAssets: { 'assets/proj_1/hashxyz': { content: PNG_BYTES, ct: 'image/png' } },
      workerResponse: apiResponse,
    });

    const res = await app.fetch(new Request('https://my-app.void.app/api/items'), env, createCtx());

    // JSON passes through; fallback must NOT be triggered even though the
    // manifest has a matching path and bytes.
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(largeBody);
  });

  it('does not trigger on small text/plain 200 that is not the stub text', async () => {
    const okBody = 'ok';
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/health': 'hashxyz' },
      staticAssets: { 'assets/proj_1/hashxyz': { content: PNG_BYTES, ct: 'image/png' } },
      workerResponse: new Response(okBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(okBody.length),
        },
      }),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/health'), env, createCtx());

    expect(await res.text()).toBe(okBody);
  });

  it('falls back through the hashed-prefix branch when the worker returns a stub', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        hashedAssetsPrefix: 'assets',
      },
      servingManifest: { '/assets/app-abc.js': 'hashjs' },
      staticAssets: {
        'assets/proj_1/hashjs': {
          content: new TextEncoder().encode('console.log(1)').buffer as ArrayBuffer,
          ct: 'application/javascript',
        },
      },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(
      new Request('https://my-app.void.app/assets/app-abc.js'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(await res.text()).toBe('console.log(1)');
  });
});
