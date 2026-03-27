import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createAssetUploadSession,
  deleteUnreferencedAssets,
  uploadAssetBuckets,
  uploadStaticAssets,
} from "../../src/assets";

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
      store.set(key, typeof value === "string" ? new TextEncoder().encode(value).buffer : value);
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
    delete: vi.fn(async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
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

const KV_THRESHOLD = 2 * 1024 * 1024; // 2 MB

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("uploadStaticAssets", () => {
  it("uploads small assets to KV and large assets to R2", async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    const smallContent = new Blob(["small file"]);
    const largeContent = new Blob([new ArrayBuffer(KV_THRESHOLD + 1)]); // > 2 MB

    const assetsByHash = new Map([
      ["smallhash0000000000000000000000", { blob: smallContent, contentType: "text/html" }],
      ["largehash0000000000000000000000", { blob: largeContent, contentType: "video/mp4" }],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash);

    expect(kv.put).toHaveBeenCalledTimes(1); // small asset
    expect(r2.put).toHaveBeenCalledTimes(1); // large asset
    expect(largeHashes.has("largehash0000000000000000000000")).toBe(true);
    expect(largeHashes.has("smallhash0000000000000000000000")).toBe(false);
  });

  it("overwrites assets that already exist in KV (idempotent puts)", async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set("assets/existinghash000000000000000000", new ArrayBuffer(1));

    const assetsByHash = new Map([
      ["existinghash000000000000000000", { blob: new Blob(["exists"]), contentType: "text/html" }],
      ["newhash00000000000000000000000", { blob: new Blob(["new"]), contentType: "text/css" }],
    ]);

    await uploadStaticAssets(kv, r2, assetsByHash);

    expect(kv.put).toHaveBeenCalledTimes(2); // both assets, no existence check
  });

  it("overwrites assets that already exist in R2 (idempotent puts)", async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    r2.store.set("assets/existinglarge00000000000000000", new ArrayBuffer(KV_THRESHOLD + 1));

    const assetsByHash = new Map([
      [
        "existinglarge00000000000000000",
        {
          blob: new Blob([new ArrayBuffer(KV_THRESHOLD + 1)]),
          contentType: "video/mp4",
        },
      ],
    ]);

    const largeHashes = await uploadStaticAssets(kv, r2, assetsByHash);

    expect(r2.put).toHaveBeenCalledTimes(1); // idempotent put, no existence check
    expect(largeHashes.has("existinglarge00000000000000000")).toBe(true);
  });
});

describe("deleteUnreferencedAssets", () => {
  it("deletes only hashes not referenced by retained deployments", async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set("assets/hash_a", new ArrayBuffer(0));
    kv.store.set("assets/hash_b", new ArrayBuffer(0));
    r2.store.set("assets/hash_c", new ArrayBuffer(0));

    const evictedHashes = ["hash_a", "hash_b", "hash_c"];
    const retainedHashes = new Set(["hash_b"]);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes);

    expect(kv.store.has("assets/hash_a")).toBe(false);
    expect(kv.store.has("assets/hash_b")).toBe(true);
    expect(r2.store.has("assets/hash_c")).toBe(false);
  });

  it("does nothing when all evicted hashes are retained", async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set("assets/hash_a", new ArrayBuffer(0));

    const evictedHashes = ["hash_a"];
    const retainedHashes = new Set(["hash_a"]);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes);

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
    expect(kv.store.has("assets/hash_a")).toBe(true);
  });

  it("does nothing when evictedHashes is empty", async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    await deleteUnreferencedAssets(kv, r2, [], new Set());

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
  });
});

describe("uploadAssetBuckets", () => {
  const singleAssetMap = new Map([
    ["hash1", { blob: new Blob(["hello"]), contentType: "text/plain" }],
  ]);

  it("returns session JWT directly when buckets are empty (all cached)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const completionJwt = await uploadAssetBuckets("acct", "session-jwt", [], singleAssetMap);

    expect(completionJwt).toBe("session-jwt");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns session JWT directly when buckets contain only empty arrays", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const completionJwt = await uploadAssetBuckets("acct", "session-jwt", [[]], singleAssetMap);

    expect(completionJwt).toBe("session-jwt");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the returned jwt when Cloudflare responds with JSON", async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { jwt: "completion-jwt" } }));
    vi.stubGlobal("fetch", fetchMock);

    const completionJwt = await uploadAssetBuckets(
      "acct",
      "session-jwt",
      [["hash1"]],
      singleAssetMap,
    );

    expect(completionJwt).toBe("completion-jwt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx errors and succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response("Bad Gateway", { status: 502 });
      }
      return Response.json({ result: { jwt: "completion-jwt" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const completionJwt = await uploadAssetBuckets(
      "acct",
      "session-jwt",
      [["hash1"]],
      singleAssetMap,
    );

    expect(completionJwt).toBe("completion-jwt");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on plain-text 2xx response (CF bug) and succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 1) {
        return new Response("Assets have already been uploaded.");
      }
      return Response.json({ result: { jwt: "completion-jwt" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const completionJwt = await uploadAssetBuckets(
      "acct",
      "session-jwt",
      [["hash1"]],
      singleAssetMap,
    );

    expect(completionJwt).toBe("completion-jwt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on non-retryable errors", async () => {
    const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadAssetBuckets("acct", "session-jwt", [["hash1"]], singleAssetMap),
    ).rejects.toThrow("asset upload failed (401)");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createAssetUploadSession", () => {
  const manifest = { "/index.html": { hash: "abc123", size: 100 } };

  it("returns jwt and buckets on success", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ result: { jwt: "session-jwt", buckets: [["abc123"]] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAssetUploadSession("acct", "token", "ns", "worker", manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: "session-jwt", buckets: [["abc123"]] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on plain-text response and succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response("Assets have already been uploaded.");
      }
      return Response.json({ result: { jwt: "retry-jwt", buckets: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAssetUploadSession("acct", "token", "ns", "worker", manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: "retry-jwt", buckets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries on plain-text responses", async () => {
    const fetchMock = vi.fn(async () => new Response("Assets have already been uploaded."));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createAssetUploadSession("acct", "token", "ns", "worker", manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow("asset upload session returned invalid response");

    // 1 initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry on HTTP error responses", async () => {
    const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createAssetUploadSession("acct", "token", "ns", "worker", manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow("asset upload session failed: Unauthorized");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
