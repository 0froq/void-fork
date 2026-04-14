import { extname } from 'node:path';
import { createHasher, hash as blake3hash } from 'blake3-jit';
import mime from 'mime';
import { retryWithBackoff } from './cf-api';
import type { AssetConfig } from './types';

class AssetUploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Non-retriable error — the hash will never appear locally. */
class AssetHashMissError extends Error {}

export interface AssetManifestEntry {
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
  if (!text.trim()) {
    return null;
  }
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
const STATIC_ASSET_UPLOAD_CONCURRENCY = 4;
const STATIC_ASSET_UPLOAD_MAX_RETRIES = 3;
const STATIC_ASSET_UPLOAD_RETRY_DELAY_MS = 250;
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
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ manifest });

  return retryWithBackoff(
    async () => {
      const response = await fetch(url, { method: 'POST', headers, body });

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
          console.log('[assets] all assets cached — no uploads needed');
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
      errorMessage: 'asset upload session returned invalid response after retries',
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
    console.log('[assets] all assets cached — session JWT is completion token');
    return jwt;
  }

  let completionJwt = '';

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
    if (next) {
      next();
    }
  }

  async function uploadBucket(bucket: string[], bucketIndex: number): Promise<void> {
    console.log(
      `[assets] uploading bucket ${bucketIndex + 1}/${buckets.length}: ${bucket.length} file(s)`,
    );

    let attempts = 0;
    let bucketGatewayErrors = 0;
    let lastErr: unknown;

    while (true) {
      // Short-circuit: another bucket already got the JWT — upload is complete
      if (completionJwt) {
        return;
      }

      await acquireSlot();
      try {
        const parts = resolveAssetUploadParts(bucket, bucketIndex, assetsByHash);
        const { body, contentType } = createBase64MultipartBody(parts);

        const result = await postAssetUpload(accountId, jwt, body, contentType);
        if (result) {
          completionJwt = result;
        }
        return;
      } catch (err) {
        if (err instanceof AssetHashMissError) {
          throw err;
        } // non-retriable
        lastErr = err;
        if (attempts >= MAX_UPLOAD_RETRIES) {
          break;
        }
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
        while (waiters.length > 0) {
          waiters.shift()!();
        }

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
    if (buckets[i].length === 0) {
      continue;
    }
    const bucketIndex = i;
    tasks.push(uploadBucket(buckets[bucketIndex], bucketIndex));
  }
  // Use allSettled so a late bucket failure doesn't abort the deploy when the
  // completion JWT was already received (CF confirmed all hashes are present).
  const results = await Promise.allSettled(tasks);

  if (completionJwt) {
    return completionJwt;
  }

  // No JWT — find the first bucket error to surface, or throw a generic message
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  throw (
    failed?.reason ?? new Error('asset upload completed but no completion JWT received from CF')
  );
}

async function postAssetUpload(
  accountId: string,
  jwt: string,
  body: BodyInit,
  contentType: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': contentType,
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
    const raw = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(raw));
    return typeof payload.exp === 'number' && payload.exp < Date.now() / 1000;
  } catch {
    return false;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const textEncoder = new TextEncoder();

interface AssetUploadPart {
  hash: string;
  entry: AssetEntry;
}

function resolveAssetUploadParts(
  bucket: string[],
  bucketIndex: number,
  assetsByHash: Map<string, AssetEntry>,
): AssetUploadPart[] {
  return bucket.map((hash) => {
    const entry = assetsByHash.get(hash);
    if (!entry) {
      throw new AssetHashMissError(
        `[assets] bucket ${bucketIndex}: hash ${hash} requested by CF but not found in assetsByHash. ` +
          `This indicates a manifest/upload mismatch — the hash was declared in the manifest ` +
          `but the corresponding file was not included in the upload.`,
      );
    }
    return { hash, entry };
  });
}

function createBase64MultipartBody(parts: AssetUploadPart[]): {
  body: ReadableStream<Uint8Array>;
  contentType: string;
} {
  const boundary = `----void-assets-${Math.random().toString(36).slice(2)}`;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  void (async () => {
    try {
      for (const { hash, entry } of parts) {
        await writer.write(
          textEncoder.encode(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${hash}"; filename="${hash}"\r\n` +
              `Content-Type: ${entry.contentType}\r\n\r\n`,
          ),
        );
        await writeBase64Blob(writer, entry.blob);
        await writer.write(textEncoder.encode('\r\n'));
      }
      await writer.write(textEncoder.encode(`--${boundary}--\r\n`));
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();

  return { body: readable, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function writeBase64Blob(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  blob: Blob,
): Promise<void> {
  const reader = blob.stream().getReader();
  let carry = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      let bytes = value;
      if (carry.length > 0) {
        bytes = new Uint8Array(carry.length + value.length);
        bytes.set(carry);
        bytes.set(value, carry.length);
        carry = new Uint8Array(0);
      }

      const encodableLength = bytes.length - (bytes.length % 3);
      if (encodableLength > 0) {
        await writer.write(textEncoder.encode(bytesToBase64(bytes.subarray(0, encodableLength))));
      }
      carry = bytes.slice(encodableLength);
    }

    if (carry.length > 0) {
      await writer.write(textEncoder.encode(bytesToBase64(carry)));
    }
  } finally {
    reader.releaseLock();
  }
}

function digestToAssetHash(digest: Uint8Array): string {
  return [...digest]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute a CF-compatible asset hash: BLAKE3 of base64(content) + extension,
 * first 32 hex chars. Matches Wrangler's hashFile algorithm exactly.
 * Must match the CLI's computeAssetHash algorithm exactly.
 */
export function computeAssetHash(content: ArrayBuffer, filePath: string): string {
  const base64 = arrayBufferToBase64(content);
  const ext = extname(filePath).substring(1);
  const input = textEncoder.encode(base64 + ext);
  return digestToAssetHash(blake3hash(input));
}

function updateBase64Hash(hasher: ReturnType<typeof createHasher>, bytes: Uint8Array): void {
  if (bytes.length === 0) {
    return;
  }
  hasher.update(textEncoder.encode(bytesToBase64(bytes)));
}

async function computeAssetHashFromBlob(blob: Blob, filePath: string): Promise<string> {
  const hasher = createHasher();
  const reader = blob.stream().getReader();
  let carry = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    let bytes = value;
    if (carry.length > 0) {
      bytes = new Uint8Array(carry.length + value.length);
      bytes.set(carry);
      bytes.set(value, carry.length);
      carry = new Uint8Array(0);
    }

    const hashableLength = bytes.length - (bytes.length % 3);
    updateBase64Hash(hasher, bytes.subarray(0, hashableLength));
    carry = bytes.slice(hashableLength);
  }

  updateBase64Hash(hasher, carry);
  hasher.update(textEncoder.encode(extname(filePath).substring(1)));
  return digestToAssetHash(hasher.finalize());
}

/**
 * Collect assets from FormData and build the CF asset manifest + hash→entry map.
 */
function getDeclaredAssetEntry(
  declaredManifest: Record<string, AssetManifestEntry> | undefined,
  path: string,
  blob: Blob,
): AssetManifestEntry | undefined {
  const entry = declaredManifest?.[path];
  if (
    entry &&
    typeof entry.hash === 'string' &&
    entry.hash.length === 32 &&
    Number.isFinite(entry.size) &&
    entry.size >= 0 &&
    entry.size === blob.size
  ) {
    return entry;
  }
}

class AssetHashMismatchError extends Error {}

export async function collectAssets(
  formData: FormData,
  declaredManifest?: Record<string, AssetManifestEntry>,
): Promise<{
  manifest: Record<string, AssetManifestEntry>;
  assetsByHash: Map<string, AssetEntry>;
}> {
  const manifest: Record<string, AssetManifestEntry> = {};
  const assetsByHash = new Map<string, AssetEntry>();

  for (const [key, value] of formData.entries()) {
    if (key.startsWith('asset:')) {
      const path = '/' + key.slice('asset:'.length);
      const blob = value as Blob;
      const declaredEntry = getDeclaredAssetEntry(declaredManifest, path, blob);
      const hash = await computeAssetHashFromBlob(blob, path);
      if (declaredEntry && declaredEntry.hash !== hash) {
        throw new AssetHashMismatchError(
          `asset hash mismatch for ${path}: declared ${declaredEntry.hash}, computed ${hash}`,
        );
      }

      manifest[path] = declaredEntry ?? { hash, size: blob.size };
      assetsByHash.set(hash, {
        blob,
        contentType: getContentType(path),
      });
    }
  }

  return { manifest, assetsByHash };
}

/**
 * Determine content type from file path using the `mime` package (same as Wrangler).
 * Falls back to "application/null" for unknown extensions — a sentinel value that
 * signals CF to omit the Content-Type header. Matches Wrangler's behavior at
 * workers-sdk/packages/wrangler/src/assets.ts.
 */
/** MIME types that are text-based and should include charset=utf-8. */
const CHARSET_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/manifest+json',
  'image/svg+xml',
]);

export function getContentType(path: string): string {
  let contentType = mime.getType(path);
  if (contentType && !contentType.includes('charset')) {
    if (contentType.startsWith('text/') || CHARSET_TYPES.has(contentType)) {
      contentType = `${contentType}; charset=utf-8`;
    }
  }
  return contentType ?? 'application/null';
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

async function uploadStaticAssetWithRetries(
  kv: KVNamespace,
  r2: R2Bucket,
  key: string,
  entry: AssetEntry,
  retryDelayMs: number,
): Promise<'kv' | 'r2'> {
  const buffer = await entry.blob.arrayBuffer();
  const store = buffer.byteLength >= KV_THRESHOLD ? 'r2' : 'kv';
  let lastErr: unknown;

  for (let attempt = 0; attempt <= STATIC_ASSET_UPLOAD_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
    }

    try {
      if (store === 'r2') {
        await r2.put(key, buffer, {
          httpMetadata: { contentType: entry.contentType },
        });
      } else {
        await kv.put(key, buffer, {
          metadata: { ct: entry.contentType },
        });
      }
      return store;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[assets] static ${store} upload failed for ${key} ` +
          `(attempt ${attempt + 1}/${STATIC_ASSET_UPLOAD_MAX_RETRIES + 1})`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  throw lastErr ?? new Error(`static asset upload failed for ${key}`);
}

/**
 * Upload static assets to KV (< 2 MB) or R2 (>= 2 MB).
 * Content-addressed keys make puts idempotent, so no existence checks needed.
 * Uploads run with bounded concurrency to avoid holding every asset body in Worker memory.
 * Returns the set of hashes that were stored in R2 (large assets).
 */
export async function uploadStaticAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  assetsByHash: Map<string, AssetEntry>,
  projectId: string,
  { retryDelayMs = STATIC_ASSET_UPLOAD_RETRY_DELAY_MS }: { retryDelayMs?: number } = {},
): Promise<Set<string>> {
  const largeHashes = new Set<string>();
  const entries = Array.from(assetsByHash);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < entries.length) {
      const [hash, entry] = entries[index++];
      const key = `assets/${projectId}/${hash}`;
      const store = await uploadStaticAssetWithRetries(kv, r2, key, entry, retryDelayMs);
      if (store === 'r2') {
        largeHashes.add(hash);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(STATIC_ASSET_UPLOAD_CONCURRENCY, entries.length) }, () =>
      worker(),
    ),
  );
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
  projectId: string,
): Promise<void> {
  const toDelete = evictedHashes.filter((h) => !retainedHashes.has(h));
  if (toDelete.length === 0) {
    return;
  }

  for (const hash of toDelete) {
    await kv.delete(`assets/${projectId}/${hash}`);
  }

  // R2 supports batch delete up to 1000 keys at a time
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000).map((h) => `assets/${projectId}/${h}`);
    await r2.delete(batch);
  }
}
