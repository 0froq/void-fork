import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  applyDeclaredAssetManifest,
  AssetHashMismatchError,
  cleanupStreamedStaticAssets,
  computeAssetHash,
  createAssetUploadSession,
  deleteUnreferencedAssets,
  uploadAssetBuckets,
  uploadStaticAssets,
  type AssetEntry,
} from '../../src/assets';

const enc = new TextEncoder();
function entry(content: string | Uint8Array, contentType: string): AssetEntry {
  return {
    bytes: typeof content === 'string' ? enc.encode(content) : content,
    contentType,
  };
}

function createMockKV() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    get: vi.fn(async (key: string, _opts?: unknown) => store.get(key) ?? null),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
    })),
    put: vi.fn(async (key: string, value: ArrayBuffer | string, _opts?: unknown) => {
      store.set(key, typeof value === 'string' ? new TextEncoder().encode(value).buffer : value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
  } as unknown as KVNamespace & { store: Map<string, ArrayBuffer> };
}

function createMockR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    put: vi.fn(async (key: string, value: ArrayBuffer, _opts?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (keys: string | Array<string>) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
      }
    }),
    get: vi.fn(async (key: string) =>
      store.has(key)
        ? {
            body: new ReadableStream(),
            httpMetadata: {},
            size: 0,
            httpEtag: '"test"',
          }
        : null,
    ),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket & { store: Map<string, ArrayBuffer> };
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy.buffer;
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value).buffer;
  }
  throw new Error('unsupported mock storage value');
}

async function readBodyText(body: unknown): Promise<string> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Array<Uint8Array> = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
  if (typeof body === 'string') {
    return body;
  }
  throw new Error('unsupported body type');
}

/** Create a JWT with the given expiration time (Unix seconds). */
function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.fake-signature`;
}

const KV_THRESHOLD = 2 * 1024 * 1024; // 2 MB

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('applyDeclaredAssetManifest', () => {
  it('prefers the declared entry when both hash and size match the built entry', () => {
    const bytes = enc.encode('hello');
    const hash = computeAssetHash(bytes.buffer, '/index.html');
    const built = { '/index.html': { hash, size: bytes.length } };
    const declared = { '/index.html': { hash, size: bytes.length } };

    const result = applyDeclaredAssetManifest(built, declared);

    expect(result).toEqual(built);
    expect(result['/index.html']).toBe(declared['/index.html']);
  });

  it('keeps the built entry when the declared size does not match', () => {
    const bytes = enc.encode('hello');
    const hash = computeAssetHash(bytes.buffer, '/index.html');
    const built = { '/index.html': { hash, size: bytes.length } };
    const declared = { '/index.html': { hash, size: bytes.length + 1 } };

    const result = applyDeclaredAssetManifest(built, declared);

    expect(result['/index.html']).toBe(built['/index.html']);
  });

  it('throws AssetHashMismatchError when the declared hash does not match the built hash', () => {
    const bytes = enc.encode('hello');
    const hash = computeAssetHash(bytes.buffer, '/index.html');
    const built = { '/index.html': { hash, size: bytes.length } };
    const declared = { '/index.html': { hash: 'a'.repeat(32), size: bytes.length } };

    expect(() => applyDeclaredAssetManifest(built, declared)).toThrow(AssetHashMismatchError);
  });
});

describe('uploadStaticAssets', () => {
  it('uploads small assets to KV and large assets to R2', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    const assetsByHash = new Map<string, AssetEntry>([
      ['smallhash0000000000000000000000', entry('small file', 'text/html')],
      ['largehash0000000000000000000000', entry(new Uint8Array(KV_THRESHOLD + 1), 'video/mp4')],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test');

    expect(kv.put).toHaveBeenCalledTimes(1); // small asset
    expect(r2.put).toHaveBeenCalledTimes(1); // large asset
    expect(largeHashes.has('largehash0000000000000000000000')).toBe(true);
    expect(largeHashes.has('smallhash0000000000000000000000')).toBe(false);
  });

  it('overwrites assets that already exist in KV (idempotent puts)', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/existinghash000000000000000000', new ArrayBuffer(1));

    const assetsByHash = new Map<string, AssetEntry>([
      ['existinghash000000000000000000', entry('exists', 'text/html')],
      ['newhash00000000000000000000000', entry('new', 'text/css')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test');

    expect(kv.put).toHaveBeenCalledTimes(2); // both assets, no existence check
  });

  it('retries transient KV upload failures', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    let attempts = 0;
    vi.mocked(kv.put).mockImplementation(async (key, value, _opts) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('temporary KV failure');
      }
      kv.store.set(key, toArrayBuffer(value));
    });

    const assetsByHash = new Map<string, AssetEntry>([
      ['retryhash000000000000000000000', entry('retry', 'text/plain')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test', { retryDelayMs: 0 });

    expect(kv.put).toHaveBeenCalledTimes(2);
    expect(kv.store.has('assets/proj_test/retryhash000000000000000000000')).toBe(true);
  });

  it('overwrites assets that already exist in R2 (idempotent puts)', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    r2.store.set(
      'assets/proj_test/existinglarge00000000000000000',
      new ArrayBuffer(KV_THRESHOLD + 1),
    );

    const assetsByHash = new Map<string, AssetEntry>([
      ['existinglarge00000000000000000', entry(new Uint8Array(KV_THRESHOLD + 1), 'video/mp4')],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test');

    expect(r2.put).toHaveBeenCalledTimes(1); // idempotent put, no existence check
    expect(largeHashes.has('existinglarge00000000000000000')).toBe(true);
  });

  it('retries transient R2 upload failures', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    let attempts = 0;
    vi.mocked(r2.put).mockImplementation(async (key, value, _opts) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('temporary R2 failure');
      }
      r2.store.set(key, toArrayBuffer(value));
      return { key } as R2Object;
    });

    const assetsByHash = new Map<string, AssetEntry>([
      ['retrylarge00000000000000000000', entry(new Uint8Array(KV_THRESHOLD + 1), 'video/mp4')],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash, 'proj_test', {
      retryDelayMs: 0,
    });

    expect(r2.put).toHaveBeenCalledTimes(2);
    expect(r2.store.has('assets/proj_test/retrylarge00000000000000000000')).toBe(true);
    expect(largeHashes.has('retrylarge00000000000000000000')).toBe(true);
  });

  it('scopes asset keys by project ID', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    const assetsByHash = new Map<string, AssetEntry>([
      ['deadbeef12345678', entry('test', 'text/plain')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_abc123');

    expect(kv.put).toHaveBeenCalledWith(
      'assets/proj_abc123/deadbeef12345678',
      expect.any(Uint8Array),
      expect.anything(),
    );
  });

  it('different projects get different keys for same hash', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    const assetsByHash = new Map<string, AssetEntry>([
      ['deadbeef12345678', entry('test', 'text/plain')],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_aaa');
    await uploadStaticAssets(kv, r2, assetsByHash, 'proj_bbb');

    expect(kv.put).toHaveBeenCalledWith(
      'assets/proj_aaa/deadbeef12345678',
      expect.any(Uint8Array),
      expect.anything(),
    );
    expect(kv.put).toHaveBeenCalledWith(
      'assets/proj_bbb/deadbeef12345678',
      expect.any(Uint8Array),
      expect.anything(),
    );
  });
});

describe('deleteUnreferencedAssets', () => {
  it('deletes only hashes not referenced by retained deployments', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));
    kv.store.set('assets/proj_test/hash_b', new ArrayBuffer(0));
    r2.store.set('assets/proj_test/hash_c', new ArrayBuffer(0));

    const evictedHashes = ['hash_a', 'hash_b', 'hash_c'];
    const retainedHashes = new Set(['hash_b']);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    expect(kv.store.has('assets/proj_test/hash_a')).toBe(false);
    expect(kv.store.has('assets/proj_test/hash_b')).toBe(true);
    expect(r2.store.has('assets/proj_test/hash_c')).toBe(false);
  });

  it('does nothing when all evicted hashes are retained', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));

    const evictedHashes = ['hash_a'];
    const retainedHashes = new Set(['hash_a']);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
    expect(kv.store.has('assets/proj_test/hash_a')).toBe(true);
  });

  it('does nothing when evictedHashes is empty', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    await deleteUnreferencedAssets(kv, r2, [], new Set(), 'proj_test');

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('only deletes project-scoped keys, not legacy shared keys', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    // Legacy key exists for the same hash
    kv.store.set('assets/hash_a', new ArrayBuffer(0));
    // Scoped key also exists
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));

    const evictedHashes = ['hash_a'];
    const retainedHashes = new Set<string>();

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    // Scoped key deleted
    expect(kv.store.has('assets/proj_test/hash_a')).toBe(false);
    // Legacy key untouched
    expect(kv.store.has('assets/hash_a')).toBe(true);
  });
});

describe('cleanupStreamedStaticAssets', () => {
  it('removes retained entries from the tracking map without deleting them', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_live', new ArrayBuffer(4));

    const uploaded = new Map<string, 'kv' | 'r2'>([['hash_live', 'kv']]);
    const retainedHashes = new Set(['hash_live']);

    await cleanupStreamedStaticAssets(kv, r2, 'proj_test', uploaded, retainedHashes);

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
    expect(kv.store.has('assets/proj_test/hash_live')).toBe(true);
    expect(uploaded.size).toBe(0);
  });

  it('deletes unreferenced entries from their recorded store and clears them', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(4));
    r2.store.set('assets/proj_test/hash_b', new ArrayBuffer(4));

    const uploaded = new Map<string, 'kv' | 'r2'>([
      ['hash_a', 'kv'],
      ['hash_b', 'r2'],
    ]);

    await cleanupStreamedStaticAssets(kv, r2, 'proj_test', uploaded, new Set());

    expect(kv.store.has('assets/proj_test/hash_a')).toBe(false);
    expect(r2.store.has('assets/proj_test/hash_b')).toBe(false);
    expect(uploaded.size).toBe(0);
  });

  it('only targets the recorded store, not both', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_r2only', new ArrayBuffer(4));
    r2.store.set('assets/proj_test/hash_r2only', new ArrayBuffer(4));

    const uploaded = new Map<string, 'kv' | 'r2'>([['hash_r2only', 'r2']]);

    await cleanupStreamedStaticAssets(kv, r2, 'proj_test', uploaded, new Set());

    // Only the R2 copy (the recorded store) is touched.
    expect(r2.delete).toHaveBeenCalledTimes(1);
    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.store.has('assets/proj_test/hash_r2only')).toBe(false);
    // KV still holds its copy (no phantom delete).
    expect(kv.store.has('assets/proj_test/hash_r2only')).toBe(true);
  });

  it('retains failed hashes in the map so a later retry can re-attempt them', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_fail', new ArrayBuffer(4));
    kv.store.set('assets/proj_test/hash_ok', new ArrayBuffer(4));

    let kvFailOnce = true;
    // First call for hash_fail throws; second call (retry) succeeds.
    kv.delete = vi.fn(async (key: string) => {
      if (key === 'assets/proj_test/hash_fail' && kvFailOnce) {
        kvFailOnce = false;
        throw new Error('transient KV failure');
      }
      kv.store.delete(key);
    });

    const uploaded = new Map<string, 'kv' | 'r2'>([
      ['hash_fail', 'kv'],
      ['hash_ok', 'kv'],
    ]);

    await cleanupStreamedStaticAssets(kv, r2, 'proj_test', uploaded, new Set());

    // First pass: hash_ok was deleted, hash_fail is still in the tracking
    // map so an outer-finally retry can re-attempt it.
    expect(uploaded.has('hash_ok')).toBe(false);
    expect(uploaded.has('hash_fail')).toBe(true);
    expect(kv.store.has('assets/proj_test/hash_fail')).toBe(true);

    // Retry pass with a fresh call — hash_fail now deletes cleanly and is
    // removed from the tracking map.
    await cleanupStreamedStaticAssets(kv, r2, 'proj_test', uploaded, new Set());
    expect(uploaded.size).toBe(0);
    expect(kv.store.has('assets/proj_test/hash_fail')).toBe(false);
  });

  it('revalidates a hash with shouldProtectHash immediately before delete', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_late', new ArrayBuffer(4));

    const uploaded = new Map<string, 'kv' | 'r2'>([['hash_late', 'kv']]);
    const shouldProtectHash = vi.fn(async (hash: string) => hash === 'hash_late');

    await cleanupStreamedStaticAssets(kv, r2, 'proj_test', uploaded, new Set(), shouldProtectHash);

    expect(shouldProtectHash).toHaveBeenCalledWith('hash_late');
    expect(kv.delete).not.toHaveBeenCalled();
    expect(kv.store.has('assets/proj_test/hash_late')).toBe(true);
    expect(uploaded.size).toBe(0);
  });
});

describe('uploadAssetBuckets', () => {
  const singleAssetMap = new Map<string, AssetEntry>([['hash1', entry('hello', 'text/plain')]]);
  const opts = { retryDelayMs: 0, gatewayDelayMs: 0 };

  it('returns session JWT directly when buckets are empty (all cached)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets('acct', 'session-jwt', [], singleAssetMap, opts);

    expect(completionJwt).toBe('session-jwt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns session JWT directly when buckets contain only empty arrays', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [[]],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('session-jwt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the returned jwt when Cloudflare responds with JSON', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { jwt: 'completion-jwt' } }));
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams base64 multipart asset bodies with correct headers and encoded content', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer session-jwt',
      });
      expect(init?.headers).toMatchObject({
        'Content-Type': expect.stringContaining('multipart/form-data; boundary='),
      });
      const body = await readBodyText(init?.body);
      expect(body).toContain('Content-Disposition: form-data; name="hash1"; filename="hash1"');
      expect(body).toContain('Content-Type: text/plain');
      expect(body).toContain('aGVsbG8=');
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
  });

  it('retries on 5xx errors and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response('Bad Gateway', { status: 502 });
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('accepts missing JWT for non-final buckets', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // First bucket (non-final): 202 with no JWT
      if (calls === 1) {
        return Response.json({ result: {} }, { status: 202 });
      }
      // Second bucket (final): 200 with completion JWT
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1'], ['hash2']],
      new Map<string, AssetEntry>([
        ['hash1', entry('a', 'text/plain')],
        ['hash2', entry('b', 'text/plain')],
      ]),
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses session JWT for auth on all buckets (no chaining)', async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1'], ['hash2']],
      new Map<string, AssetEntry>([
        ['hash1', entry('a', 'text/plain')],
        ['hash2', entry('b', 'text/plain')],
      ]),
      opts,
    );

    // Both calls should use session JWT, not the response JWT from bucket 1
    for (const call of fetchMock.mock.calls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (call as any)[1] as { headers: { Authorization: string } };
      expect(options.headers.Authorization).toBe('Bearer session-jwt');
    }
  });

  it('retries malformed 2xx (CF edge bug) and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 1) {
        return new Response('Assets have already been uploaded.');
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when no bucket returns a completion JWT', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: {} }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('no completion JWT received');

    // Valid response — no retries burned, just 1 call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 4xx errors before throwing (matches Wrangler)', async () => {
    const fetchMock = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (401)');

    // 4xx errors are retried just like 5xx (matching Wrangler's behavior)
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('524 gateway errors get free retries before counting as attempts', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // Return 524 for the first 6 calls, then succeed
      if (calls <= 6) {
        return new Response('A timeout occurred', { status: 524 });
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    // 6 failures + 1 success = 7 calls. The first 4 gateway errors are free
    // (gwErr 1-4, attempts stays 0). The 5th (gwErr=5 >= MAX=5) increments
    // attempts to 1, the 6th increments to 2. Call 7 succeeds.
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('throws after exhausting gateway + regular retries', async () => {
    // Always return 524 — eventually should exhaust all retries
    const fetchMock = vi.fn(async () => new Response('A timeout occurred', { status: 524 }));
    vi.stubGlobal('fetch', fetchMock);

    // Rethrows the original AssetUploadError (matching Wrangler's `throw e;`)
    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (524)');

    // 4 free gateway errors (gwErr 1-4, attempts stays 0)
    // + 6 counted (gwErr 5-10, each increments attempts 1→2→3→4→5→check fails)
    // = 10 total calls
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('uploads buckets concurrently', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const fetchMock = vi.fn(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Yield to let other concurrent tasks start
      await new Promise((r) => setTimeout(r, 1));
      currentConcurrent--;
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['h1'], ['h2'], ['h3']],
      new Map<string, AssetEntry>([
        ['h1', entry('a', 'text/plain')],
        ['h2', entry('b', 'text/plain')],
        ['h3', entry('c', 'text/plain')],
      ]),
      opts,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // All 3 should run concurrently since UPLOAD_CONCURRENCY=3
    expect(maxConcurrent).toBe(3);
  });

  it('JWT expiration gives specific error message when retries exhausted', async () => {
    // JWT that expired 1 hour ago
    const expiredJwt = makeJwt(Math.floor(Date.now() / 1000) - 3600);
    const fetchMock = vi.fn(async () => new Response('Server Error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', expiredJwt, [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow(/upload session has expired/);
  });

  it('rethrows original error when retries exhausted and JWT valid', async () => {
    // JWT that expires in 1 hour
    const validJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const fetchMock = vi.fn(async () => new Response('Server Error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    // Original AssetUploadError is rethrown (matching Wrangler's `throw e;`)
    await expect(
      uploadAssetBuckets('acct', validJwt, [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (500)');
  });
});

describe('createAssetUploadSession', () => {
  const manifest = { '/index.html': { hash: 'abc123', size: 100 } };

  it('returns jwt and buckets on success', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ result: { jwt: 'session-jwt', buckets: [['abc123']] } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'session-jwt', buckets: [['abc123']] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on plain-text response and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response('Assets have already been uploaded.');
      }
      return Response.json({ result: { jwt: 'retry-jwt', buckets: [] } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'retry-jwt', buckets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on plain-text responses', async () => {
    const fetchMock = vi.fn(async () => new Response('Assets have already been uploaded.'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('asset upload session returned invalid response');

    // 1 initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry on HTTP error responses', async () => {
    const fetchMock = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('asset upload session failed: Unauthorized');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
