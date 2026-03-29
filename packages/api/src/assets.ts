import type { AssetConfig } from "./types";
import { retryWithBackoff } from "./cf-api";

class AssetUploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface AssetManifestEntry {
  hash: string;
  size: number;
}

export interface AssetEntry {
  blob: Blob;
  contentType: string;
}

interface UploadSessionResponse {
  result: {
    jwt: string;
    buckets: string[][];
  };
}

function tryParseJson<T>(text: string): T | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const ASSET_SESSION_MAX_RETRIES = 3;
const ASSET_SESSION_RETRY_DELAY_MS = 1000;
const ASSET_BUCKET_UPLOAD_RETRY_DELAY_MS = 1000;

const MAX_UPLOAD_RETRIES = 5; // 5 retries + 1 initial = 6 total tries (matching Wrangler)
const UPLOAD_CONCURRENCY = 3;
const GATEWAY_BACKOFF_BASE_MS = 5000;
const MAX_GATEWAY_ERRORS = 5; // start counting attempts after this many 524s (4 free retries)

/**
 * Step 1: Create an asset upload session with CF.
 * Sends the asset manifest (path → {hash, size}) and receives a completion JWT
 * plus "buckets" — groups of hashes that CF needs uploaded.
 *
 * CF's WfP assets API sometimes returns plain text (e.g. "Assets have already
 * been uploaded") instead of JSON when all asset hashes already exist. This is
 * a CF bug — the response varies by edge node. Retrying typically hits a
 * different node that returns proper JSON.
 */
export async function createAssetUploadSession(
  accountId: string,
  apiToken: string,
  namespace: string,
  workerName: string,
  manifest: Record<string, AssetManifestEntry>,
  { retryDelayMs = ASSET_SESSION_RETRY_DELAY_MS }: { retryDelayMs?: number } = {},
): Promise<{ jwt: string; buckets: string[][] }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${workerName}/assets-upload-session`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({ manifest });

  return retryWithBackoff(
    async () => {
      const response = await fetch(url, { method: "POST", headers, body });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[assets] upload session failed (${response.status}): ${error}`);
        throw new Error(`asset upload session failed: ${error}`);
      }

      const text = await response.text();
      const data = tryParseJson<UploadSessionResponse>(text);
      if (data?.result?.jwt && Array.isArray(data.result.buckets)) {
        const bucketCount = data.result.buckets.length;
        const hashCount = data.result.buckets.flat().length;
        console.log(
          `[assets] session created: ${bucketCount} bucket(s), ${hashCount} hash(es) to upload`,
        );
        if (hashCount === 0) {
          console.log("[assets] all assets cached — no uploads needed");
        }
        return { jwt: data.result.jwt, buckets: data.result.buckets };
      }
      console.warn(
        `[assets] session response missing jwt or buckets, retrying. raw: ${text.slice(0, 200)}`,
      );
      return undefined; // retry — likely CF plain-text bug
    },
    {
      maxRetries: ASSET_SESSION_MAX_RETRIES,
      delayMs: retryDelayMs,
      errorMessage: "asset upload session returned invalid response after retries",
    },
  );
}

/**
 * Step 2: Upload asset file contents for each bucket.
 *
 * Buckets are uploaded concurrently (up to UPLOAD_CONCURRENCY). On CF gateway
 * errors (524), concurrency drops to 1 and gateway-specific backoff applies.
 * Gateway errors get several free retries before counting against the attempt
 * limit, matching Wrangler's behavior.
 */
export async function uploadAssetBuckets(
  accountId: string,
  jwt: string,
  buckets: string[][],
  assetsByHash: Map<string, AssetEntry>,
  {
    retryDelayMs = ASSET_BUCKET_UPLOAD_RETRY_DELAY_MS,
    gatewayDelayMs = GATEWAY_BACKOFF_BASE_MS,
  }: { retryDelayMs?: number; gatewayDelayMs?: number } = {},
): Promise<string> {
  if (!buckets.some((b) => b.length > 0)) {
    console.log("[assets] all assets cached — session JWT is completion token");
    return jwt;
  }

  let completionJwt = "";

  // Adaptive concurrency — shared across bucket tasks, drops to 1 on 524
  let concurrency = UPLOAD_CONCURRENCY;
  let activeCount = 0;
  const waiters: (() => void)[] = [];

  async function acquireSlot(): Promise<void> {
    while (activeCount >= concurrency) {
      await new Promise<void>((r) => waiters.push(r));
    }
    activeCount++;
  }

  function releaseSlot(): void {
    activeCount--;
    const next = waiters.shift();
    if (next) next();
  }

  async function uploadBucket(bucket: string[], bucketIndex: number): Promise<void> {
    console.log(
      `[assets] uploading bucket ${bucketIndex + 1}/${buckets.length}: ${bucket.length} file(s)`,
    );

    let attempts = 0;
    let bucketGatewayErrors = 0;
    let lastErr: unknown;

    // Base64 entries are computed once (on first slot acquisition) and reused
    // for retries. Lazy init ensures encoding happens under the concurrency
    // limit, not all-at-once when buckets are dispatched.
    let entries: { hash: string; base64: string; contentType: string }[] | null = null;

    while (true) {
      // Short-circuit: another bucket already got the JWT — upload is complete
      if (completionJwt) return;

      await acquireSlot();
      try {
        if (!entries) {
          const built: { hash: string; base64: string; contentType: string }[] = [];
          for (const hash of bucket) {
            const entry = assetsByHash.get(hash);
            if (!entry) {
              console.warn(
                `[assets] bucket ${bucketIndex}: hash ${hash} not found in assetsByHash, skipping`,
              );
              continue;
            }
            const buffer = await entry.blob.arrayBuffer();
            built.push({
              hash,
              base64: arrayBufferToBase64(buffer),
              contentType: entry.contentType,
            });
          }
          entries = built;
        }

        const formData = new FormData();
        for (const { hash, base64, contentType } of entries) {
          formData.append(hash, new File([base64], hash, { type: contentType }), hash);
        }

        const result = await postAssetUpload(accountId, jwt, formData);
        if (result) completionJwt = result;
        return;
      } catch (err) {
        lastErr = err;
        if (attempts >= MAX_UPLOAD_RETRIES) break;
      } finally {
        releaseSlot();
      }

      // Error path — slot already released, backoff outside the concurrency limit
      console.warn(
        `[assets] bucket ${bucketIndex + 1} upload failed, retrying...`,
        lastErr instanceof Error ? lastErr.message : lastErr,
      );

      await new Promise((r) => setTimeout(r, Math.pow(2, attempts) * retryDelayMs));

      if (lastErr instanceof AssetUploadError && lastErr.status === 524) {
        // Gateway error — throttle concurrency + additional backoff
        concurrency = 1;
        while (waiters.length > 0) waiters.shift()!();

        await new Promise((r) => setTimeout(r, Math.pow(2, bucketGatewayErrors) * gatewayDelayMs));
        bucketGatewayErrors++;
        console.warn(
          `[assets] bucket ${bucketIndex + 1} gateway error (524), ` +
            `concurrency → 1, gateway errors: ${bucketGatewayErrors}/${MAX_GATEWAY_ERRORS}`,
        );
        if (bucketGatewayErrors >= MAX_GATEWAY_ERRORS) {
          attempts++;
        }
      } else {
        attempts++;
      }
    }

    // All retries exhausted
    if (isJwtExpired(jwt)) {
      throw new Error(
        `Asset upload timed out on bucket ${bucketIndex + 1}/${buckets.length} — the upload session has expired. ` +
          `Assets already uploaded have been saved, so the next attempt will automatically resume from this point.`,
      );
    }
    throw lastErr;
  }

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].length === 0) continue;
    const bucketIndex = i;
    tasks.push(uploadBucket(buckets[bucketIndex], bucketIndex));
  }
  // Use allSettled so a late bucket failure doesn't abort the deploy when the
  // completion JWT was already received (CF confirmed all hashes are present).
  const results = await Promise.allSettled(tasks);

  if (completionJwt) return completionJwt;

  // No JWT — find the first bucket error to surface, or throw a generic message
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  throw (
    failed?.reason ?? new Error("asset upload completed but no completion JWT received from CF")
  );
}

async function postAssetUpload(
  accountId: string,
  jwt: string,
  body: FormData,
): Promise<string | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      body,
    },
  );

  if (!response.ok) {
    const status = response.status;
    const error = await response.text();
    console.error(`[assets] upload failed (${status}): ${error.slice(0, 500)}`);
    throw new AssetUploadError(status, `asset upload failed (${status}): ${error}`);
  }

  const text = await response.text();
  const data = tryParseJson<{ result?: { jwt?: string } }>(text);
  // Wrangler's fetchResult throws on malformed JSON responses. Match that:
  // a valid CF response always has a `result` key. Plain-text 2xx bodies
  // (CF edge-node bug) or unexpected JSON shapes should be retried.
  if (!data?.result) {
    throw new AssetUploadError(response.status, `malformed upload response: ${text.slice(0, 200)}`);
  }
  return data.result.jwt ?? null;
}

function isJwtExpired(jwt: string): boolean {
  try {
    // CF JWTs use base64url encoding — normalize to standard base64 before decoding
    const raw = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(raw));
    return typeof payload.exp === "number" && payload.exp < Date.now() / 1000;
  } catch {
    return false;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Compute a CF-compatible asset hash: SHA-256, truncated to first 32 hex chars.
 */
export async function computeAssetHash(content: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", content);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 32);
}

/**
 * Collect assets from FormData and build the CF asset manifest + hash→entry map.
 */
export async function collectAssets(formData: FormData): Promise<{
  manifest: Record<string, AssetManifestEntry>;
  assetsByHash: Map<string, AssetEntry>;
}> {
  const manifest: Record<string, AssetManifestEntry> = {};
  const assetsByHash = new Map<string, AssetEntry>();

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("asset:")) {
      const path = "/" + key.slice("asset:".length);
      const blob = value as Blob;
      const buffer = await blob.arrayBuffer();
      const hash = await computeAssetHash(buffer);
      manifest[path] = { hash, size: buffer.byteLength };
      assetsByHash.set(hash, {
        blob,
        contentType: getContentType(path),
      });
    }
  }

  return { manifest, assetsByHash };
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json; charset=utf-8",
  map: "application/json; charset=utf-8",
};

function getContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Build the worker metadata with assets JWT and config attached.
 */
export function buildAssetMetadata(
  jwt: string,
  config?: AssetConfig,
): { jwt: string; config?: AssetConfig } {
  return {
    jwt,
    ...(config ? { config } : {}),
  };
}

const KV_THRESHOLD = 2 * 1024 * 1024; // 2 MB

/**
 * Upload static assets to KV (< 2 MB) or R2 (>= 2 MB).
 * Content-addressed keys make puts idempotent, so no existence checks needed.
 * Uploads run concurrently in batches for speed.
 * Returns the set of hashes that were stored in R2 (large assets).
 */
export async function uploadStaticAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  assetsByHash: Map<string, AssetEntry>,
): Promise<Set<string>> {
  const largeHashes = new Set<string>();
  const tasks: Promise<void>[] = [];

  for (const [hash, entry] of assetsByHash) {
    const key = `assets/${hash}`;
    const task = entry.blob.arrayBuffer().then(async (buffer) => {
      if (buffer.byteLength >= KV_THRESHOLD) {
        await r2.put(key, buffer, {
          httpMetadata: { contentType: entry.contentType },
        });
        largeHashes.add(hash);
      } else {
        await kv.put(key, buffer, {
          metadata: { ct: entry.contentType },
        });
      }
    });
    tasks.push(task);
  }

  await Promise.all(tasks);
  return largeHashes;
}

/**
 * Delete assets that are no longer referenced by any retained deployment.
 * Deletes from both KV and R2 (content-addressed keys live in one or the other,
 * but we clean both since we don't track which store holds a given hash).
 */
export async function deleteUnreferencedAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  evictedHashes: string[],
  retainedHashes: Set<string>,
): Promise<void> {
  const toDelete = evictedHashes.filter((h) => !retainedHashes.has(h));
  if (toDelete.length === 0) return;

  for (const hash of toDelete) {
    await kv.delete(`assets/${hash}`);
  }

  // R2 supports batch delete up to 1000 keys at a time
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000).map((h) => `assets/${h}`);
    await r2.delete(batch);
  }
}
