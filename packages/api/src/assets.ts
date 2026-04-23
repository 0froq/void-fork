import { extname } from 'node:path';
import { createHasher, hash as blake3hash } from 'blake3-jit';
import mime from 'mime';
import { retryWithBackoff } from './cf-api';
import { MultipartParseError, PartTooLargeError } from './multipart';
import type { AssetConfig } from './types';

// Per-asset upload size is bounded by which path consumes the bytes:
//
//   - `streamStaticAssetToR2` (direct-to-R2 streaming, SPA/static deploys
//     with a declared manifest) pipes bytes straight through a hashing
//     Transform into `r2.put`. Per-asset residency is O(hasher state +
//     one chunk in flight) ≈ 64 KiB, independent of asset size. The
//     effective ceiling is R2's 5 GiB single-`put` limit.
//
//   - Buffered paths (`readAssetBody`, worker-backed `collectBufferedAsset`,
//     the streamed-static pool) allocate a contiguous Uint8Array of the
//     asset size. There is no per-asset cap and no aggregate cap — the
//     128 MiB Worker isolate memory hard wall is the ultimate backstop,
//     alongside per-part caps that apply to other multipart fields
//     (`MAX_WORKER_FILE_BYTES`, `MAX_MANIFEST_BYTES`, etc. in deploy.ts).

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
  bytes: Uint8Array;
  contentType: string;
}

interface UploadSessionResponse {
  result: {
    jwt: string;
    buckets: Array<Array<string>>;
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
/**
 * Maximum concurrent static-asset KV/R2 PUTs per deploy. Used by the
 * worker-free (streamed) deploy path so the handler can fan uploads out
 * while the main parse loop keeps draining the inbound multipart request
 * body. Exported so the deploy handler shares the limit with
 * `uploadStaticAssets` (post-parse bulk upload), keeping the two paths
 * from accidentally drifting.
 */
export const STATIC_ASSET_UPLOAD_CONCURRENCY = 4;
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
): Promise<{ jwt: string; buckets: Array<Array<string>> }> {
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
  buckets: Array<Array<string>>,
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
  const waiters: Array<() => void> = [];

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

  async function uploadBucket(bucket: Array<string>, bucketIndex: number): Promise<void> {
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

  const tasks: Array<Promise<void>> = [];
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
  bucket: Array<string>,
  bucketIndex: number,
  assetsByHash: Map<string, AssetEntry>,
): Array<AssetUploadPart> {
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

function createBase64MultipartBody(parts: Array<AssetUploadPart>): {
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
        await writeBase64Bytes(writer, entry.bytes);
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

// Emit base64 of `bytes` to `writer` in bounded chunks so a large asset is
// never rendered into a single mega-allocation. Chunks are aligned to 3 bytes
// (base64's natural boundary) except for the final tail, which pads as usual.
async function writeBase64Bytes(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> {
  const STEP = 48 * 1024; // 48 KiB raw → 64 KiB of base64 output
  let offset = 0;
  while (offset + STEP < bytes.length) {
    await writer.write(textEncoder.encode(bytesToBase64(bytes.subarray(offset, offset + STEP))));
    offset += STEP;
  }
  if (offset < bytes.length) {
    await writer.write(textEncoder.encode(bytesToBase64(bytes.subarray(offset))));
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

/**
 * Stream-read a multipart asset body, hashing incrementally as bytes arrive
 * and assembling them into a single Uint8Array at the end. Replaces the
 * previous `await new Response(body).blob()` → `blob.arrayBuffer()` pipeline
 * that held each asset in memory twice. Memory ceiling is the 128 MiB Worker
 * isolate budget — there is no per-asset or aggregate cap here.
 */
async function readAssetBody(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<{ bytes: Uint8Array; hash: string; size: number }> {
  const hasher = createHasher();
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  let carry = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.length === 0) {
        continue;
      }
      total += value.length;
      chunks.push(value);

      // Hash incrementally on 3-byte-aligned blocks so we never need to
      // re-base64 the whole payload at the end.
      let combined = value;
      if (carry.length > 0) {
        combined = new Uint8Array(carry.length + value.length);
        combined.set(carry);
        combined.set(value, carry.length);
        carry = new Uint8Array(0);
      }
      const hashableLength = combined.length - (combined.length % 3);
      if (hashableLength > 0) {
        updateBase64Hash(hasher, combined.subarray(0, hashableLength));
      }
      carry = combined.slice(hashableLength);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be in a terminal state; nothing to release.
    }
  }

  updateBase64Hash(hasher, carry);
  hasher.update(textEncoder.encode(extname(path).substring(1)));
  const hash = digestToAssetHash(hasher.finalize());

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, hash, size: total };
}

export class AssetHashMismatchError extends Error {}

/**
 * Stream-consume a multipart asset body without buffering its bytes, hashing
 * incrementally and verifying against the declared hash/size. Used by the
 * streamed-static fast-path to validate duplicate-hash parts: the server
 * already holds the first occurrence's content under `assets/${projectId}/
 * ${declared.hash}`, so we have no need to keep the duplicate's bytes — we
 * only need to prove the duplicate really does hash to the same value (which
 * in turn proves the client isn't smuggling corrupted or tampered content
 * into a deployment entry that points at trusted bytes).
 *
 * Shares the hash construction with `readAssetBody` — base64 of content
 * plus the path extension — so a byte-for-byte identical asset produces the
 * identical hash regardless of which path consumed it. Throws in three
 * cases, all of which the deploy handler maps to an NDJSON error event:
 *   - `PartTooLargeError` if the body exceeds the declared size (client lied
 *     about how big the asset is, or the stream was extended mid-flight)
 *   - `MultipartParseError` if stream ends with a byte count not equal to
 *      `declared.size` (size lie, zero-padded body, truncated body, etc.)
 *   - `AssetHashMismatchError` if the computed hash doesn't match `declared.hash`
 *
 * Worker memory cost: ~O(hasher-state) plus a single CRLF-carry Uint8Array
 * (≤ 2 bytes). The transport chunks are never retained past one iteration.
 */
export async function verifyStreamedAssetPart(
  body: ReadableStream<Uint8Array>,
  path: string,
  declared: { hash: string; size: number },
): Promise<void> {
  const hasher = createHasher();
  const reader = body.getReader();
  let total = 0;
  let carry = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.length === 0) {
        continue;
      }
      total += value.length;
      if (total > declared.size) {
        // Client declared `declared.size` and agreed to that as the
        // per-asset cap; a stream that produces more bytes is a protocol
        // violation we surface as 413. The post-pipe total-vs-declared
        // check below catches the opposite case (short stream).
        throw new PartTooLargeError(`asset:${path}`, declared.size);
      }
      let combined = value;
      if (carry.length > 0) {
        combined = new Uint8Array(carry.length + value.length);
        combined.set(carry);
        combined.set(value, carry.length);
        carry = new Uint8Array(0);
      }
      const hashableLength = combined.length - (combined.length % 3);
      if (hashableLength > 0) {
        updateBase64Hash(hasher, combined.subarray(0, hashableLength));
      }
      carry = combined.slice(hashableLength);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be in a terminal state; nothing to release.
    }
  }

  updateBase64Hash(hasher, carry);
  hasher.update(textEncoder.encode(extname(path).substring(1)));
  const actualHash = digestToAssetHash(hasher.finalize());

  if (total !== declared.size) {
    throw new MultipartParseError(
      `asset:${path} body size ${total} does not match declared ${declared.size}`,
    );
  }
  if (actualHash !== declared.hash) {
    throw new AssetHashMismatchError(
      `asset:${path}: declared hash ${declared.hash}, computed ${actualHash}`,
    );
  }
}

/**
 * Stream a multipart asset body directly into R2 without buffering its bytes
 * in Worker memory. Memory cost is O(1) per asset — just the BLAKE3 hasher
 * state plus a ≤ 2-byte carry for 3-byte-aligned base64 hashing — so a large
 * SPA bundle no longer pins its full size against the 128 MiB request budget.
 *
 * Pipeline shape (deliberate — NOT `tee()`):
 *
 *   body ─▶ hashingTransform ─▶ FixedLengthStream ─▶ r2.put
 *
 * Each byte passes through exactly once, in order, with the hasher updated
 * synchronously inside `transform`. A `tee()` fork would buffer for the
 * slower branch and reintroduce asset-sized residency — defeating the point.
 *
 * Invariants (all load-bearing, do not weaken without understanding why):
 *
 *   1. `onlyIf: { etagDoesNotMatch: '*' }` makes this a conditional write.
 *      R2 returns `null` when the content-addressed key already exists,
 *      which means another deploy (identical bytes) has already populated
 *      the key and our put was a no-op. Without the precondition, a put
 *      with *different* bytes (a lying client, or a mangled stream) would
 *      silently overwrite trusted content that a retained deployment is
 *      still serving. The `*` wildcard means "fail if any etag is present"
 *      i.e. "write iff the object doesn't exist" — confirmed against
 *      workers-sdk R2 semantics and miniflare.
 *
 *   2. The returned promise type is `Promise<R2Object | null>` *only*
 *      because `onlyIf` is present. The TS overload on `R2Bucket.put`
 *      reflects this — without `onlyIf`, put resolves to non-null
 *      `R2Object` and a null-check would be dead code.
 *
 *   3. We verify the computed hash against `declared.hash` AFTER the stream
 *      settles. Skipping verification on an existing-key hit would let a
 *      malicious client commit a manifest entry pointing at bytes it does
 *      not own — the duplicate-hash fast-path in PR #93 had exactly this
 *      bug before review caught it. We compute regardless of whether we
 *      wrote or hit the precondition miss.
 *
 *   4. Hash construction matches `readAssetBody` / `verifyStreamedAssetPart`
 *      exactly: base64 of the bytes, accumulated on 3-byte-aligned blocks
 *      through the hasher, then the path extension appended as the final
 *      update, then first 16 bytes of the BLAKE3 digest as lowercase hex.
 *      A byte-for-byte identical asset therefore produces the identical
 *      hash regardless of which code path consumed it.
 *
 *   5. If our put wrote bytes but the computed hash doesn't match
 *      `declared.hash`, we delete the key we just wrote. If the put was a
 *      precondition miss (pre-existing key), we DO NOT delete — another
 *      retained deployment may still depend on those bytes, and the miss
 *      is proof our stream never reached R2 in the first place.
 *
 *   6. `FixedLengthStream` rejects the pipe-through promise with a
 *      `TypeError` the instant actual bytes diverge from `declared.size`
 *      (too few or too many). We map that single failure mode to
 *      `MultipartParseError` so the deploy handler emits an NDJSON parse
 *      error — every other error (R2 transport, hash computation) passes
 *      through unchanged.
 *
 * The parse loop is intentionally serialized while this function runs: the
 * multipart parser cannot advance past `part.body` until its ReadableStream
 * is drained, and our pipeline is the drain. Callers must drain any
 * concurrent upload pool BEFORE invoking this function, so the reader
 * doesn't race with other in-flight pool tasks on the same request body.
 */
export async function streamStaticAssetToR2(
  r2: R2Bucket,
  projectId: string,
  path: string,
  body: ReadableStream<Uint8Array>,
  declared: { hash: string; size: number },
  contentType: string,
): Promise<{ store: 'r2'; isNew: boolean }> {
  const hasher = createHasher();
  let carry = new Uint8Array(0);
  // Count bytes directly in our hashing transform so we can surface
  // size-mismatch deterministically as `MultipartParseError`, independent
  // of whatever FixedLengthStream / R2 transport happen to throw. A short
  // stream closes with `bytesSeen < declared.size` (pipeTo resolves even
  // though FixedLengthStream erred because workerd cancels the writable
  // first); a long stream errors inside transform when we exceed the cap.
  let bytesSeen = 0;

  const hashingTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.length > 0) {
        bytesSeen += chunk.length;
        if (bytesSeen > declared.size) {
          // Match the per-asset cap semantics: error the instant we exceed
          // the declared ceiling rather than letting more bytes flow into
          // FixedLengthStream (which would also reject, but we want the
          // deterministic client-visible error shape).
          controller.error(
            new MultipartParseError(`asset:${path} body exceeds declared size ${declared.size}`),
          );
          return;
        }
        // Match `readAssetBody`: only hash 3-byte-aligned prefixes so the
        // final base64 encoding matches a one-shot `bytesToBase64(wholeFile)`.
        // The < 3-byte tail carries into the next chunk and is flushed after
        // the pipe settles.
        let combined = chunk;
        if (carry.length > 0) {
          combined = new Uint8Array(carry.length + chunk.length);
          combined.set(carry);
          combined.set(chunk, carry.length);
          carry = new Uint8Array(0);
        }
        const hashableLength = combined.length - (combined.length % 3);
        if (hashableLength > 0) {
          updateBase64Hash(hasher, combined.subarray(0, hashableLength));
        }
        carry = combined.slice(hashableLength);
      }
      controller.enqueue(chunk);
    },
  });

  const fixed = new FixedLengthStream(declared.size);
  const key = `assets/${projectId}/${declared.hash}`;

  const pipePromise = body.pipeThrough(hashingTransform).pipeTo(fixed.writable);

  let result: R2Object | null = null;
  // Track the R2 put rejection separately so we can tell, in the catch
  // below, whether the pipeline failed because of a genuine client-side
  // size issue or because `r2.put` rejected and cancelled its consumer.
  // Both sides propagate the same error through the shared FixedLengthStream
  // when anything goes wrong, so the catch can't rely on `Promise.all`
  // alone to identify the root cause — see the class-based disambiguation
  // below.
  let putFailure: unknown | undefined;
  try {
    // Run put and the pipe concurrently: `r2.put` starts draining
    // `fixed.readable` as soon as bytes are available, and the pipe feeds
    // bytes in. If either side errors (over-sized body, FixedLengthStream
    // short-stream, R2 transport), the other settles too.
    const putPromise = r2
      .put(key, fixed.readable, {
        httpMetadata: { contentType },
        onlyIf: { etagDoesNotMatch: '*' },
      })
      .catch((err: unknown) => {
        putFailure = err;
        throw err;
      });
    [result] = await Promise.all([putPromise, pipePromise]);
  } catch (err) {
    // Our overflow transform routes size-cap violations via
    // `controller.error(new MultipartParseError(...))` — that class is
    // unambiguously client-side, pass through untouched.
    if (err instanceof MultipartParseError) {
      throw err;
    }
    // R2 put rejection is the root cause. ALWAYS prefer it raw, including
    // the case where put's rejection reason is itself a TypeError. Mid-
    // upload R2 failures cancel the consumer and leave `bytesSeen <
    // declared.size` as a downstream cascade, so the short-read symptom
    // is NOT a reliable indicator of a client-sent short body when the
    // put side failed. Surfacing `putFailure` untransformed sends the
    // real infra error to the outer deploy handler, which maps it to
    // the generic "internal error" event (no leakage of internals), and
    // keeps the parse-step error channel reserved for genuinely
    // client-visible protocol violations.
    if (putFailure !== undefined) {
      throw putFailure;
    }
    // Pipe rejected without a corresponding put failure — the put either
    // already finished (e.g., received all bytes and resolved) or was
    // never reached. `bytesSeen < declared.size` at this point confirms
    // FixedLengthStream's close-with-wrong-count TypeError on a genuine
    // short body. Rewrite to the clean client-facing parse error.
    if (err instanceof TypeError && bytesSeen < declared.size) {
      throw new MultipartParseError(
        `asset:${path} body size ${bytesSeen} does not match declared ${declared.size}`,
      );
    }
    throw err;
  }

  // Defensive: the happy path shouldn't hit this, but if a pipeline ever
  // lets an under-sized stream through silently, we catch it here.
  if (bytesSeen !== declared.size) {
    if (result !== null) {
      try {
        await r2.delete(key);
      } catch (delErr) {
        console.warn(
          `[assets] failed to delete under-sized R2 blob ${key}`,
          delErr instanceof Error ? delErr.message : delErr,
        );
      }
    }
    throw new MultipartParseError(
      `asset:${path} body size ${bytesSeen} does not match declared ${declared.size}`,
    );
  }

  // Flush the final < 3-byte carry (the base64 tail that `readAssetBody`
  // emits with padding on the last write) and append the path extension,
  // matching both `readAssetBody` and `verifyStreamedAssetPart`.
  updateBase64Hash(hasher, carry);
  hasher.update(textEncoder.encode(extname(path).substring(1)));
  const actualHash = digestToAssetHash(hasher.finalize());

  if (actualHash !== declared.hash) {
    // Only delete if we actually wrote bytes. A precondition miss means the
    // key already held content a prior retained deployment depends on —
    // deleting it would poison that deployment. The hash mismatch still
    // aborts the current deploy, but it aborts SAFELY.
    if (result !== null) {
      try {
        await r2.delete(key);
      } catch (delErr) {
        // Log and swallow — we're already on the error path, and a
        // lingering orphaned blob will be caught by the retained-hash
        // sweep in `cleanupStreamedStaticAssets`.
        console.warn(
          `[assets] failed to delete mismatched R2 blob ${key}`,
          delErr instanceof Error ? delErr.message : delErr,
        );
      }
    }
    throw new AssetHashMismatchError(
      `asset:${path}: declared hash ${declared.hash}, computed ${actualHash}`,
    );
  }

  // result === null: precondition miss. An identical content-addressed key
  // already exists and we left it untouched. Hash verified above, so the
  // caller can commit the manifest entry and treat this as a dedupe hit
  // (isNew: false — no new bytes written this request).
  // result !== null: we wrote, and the bytes hash to what the client said.
  return { store: 'r2', isNew: result !== null };
}

/** A streamed static-asset part that has been read + hashed but not yet uploaded. */
export interface PreparedStaticAsset {
  bytes: Uint8Array;
  hash: string;
  size: number;
  contentType: string;
}

/**
 * Stream-read one multipart asset body for the streamed-static deploy path,
 * hashing incrementally.
 *
 * Split out from the old `collectAndUploadStaticAsset` so the deploy handler
 * can perform reads inline in the parse loop (keeping the upstream request
 * reader draining) while fanning KV/R2 uploads out to a bounded concurrency
 * pool. Performing the upload inline caused the inbound-body reader to
 * starve on asset-heavy deploys, surfacing as "Connection lost during
 * deploy" in the CLI.
 */
export async function readStaticAssetPart(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<PreparedStaticAsset> {
  const { bytes, hash, size } = await readAssetBody(body, path);
  return { bytes, hash, size, contentType: getContentType(path) };
}

/**
 * Upload a pre-read static-asset blob to KV (< 2 MB) or R2 (>= 2 MB), with
 * content-hash dedupe against `uploadedHashes` plus an in-flight registry
 * so concurrent pool tasks with the same content hash collapse into a
 * single KV/R2 PUT. Callers typically pair this with
 * {@link readStaticAssetPart} so reads can happen sequentially in the
 * multipart parse loop while uploads fan out to a concurrency-limited pool.
 *
 * Concurrency invariant (why `inFlightUploadByHash` is required):
 * `uploadedHashes` is only populated *after* an upload settles, so two
 * tasks racing on the same new hash would both miss the completed cache
 * and both issue a full PUT — doubling cost and inflating the
 * `isNew: true` count. The synchronous `get` → `set` on
 * `inFlightUploadByHash` below (no await between them) closes that
 * window: the second task finds a pending promise and joins it as
 * `isNew: false`, guaranteeing exactly one PUT per content hash per
 * request.
 */
export async function uploadStaticAssetPart(
  kv: KVNamespace,
  r2: R2Bucket,
  projectId: string,
  prepared: PreparedStaticAsset,
  uploadedHashes: Map<string, 'kv' | 'r2'>,
  inFlightUploadByHash: Map<string, Promise<'kv' | 'r2'>>,
  {
    retryDelayMs = STATIC_ASSET_UPLOAD_RETRY_DELAY_MS,
    onHashed,
  }: {
    retryDelayMs?: number;
    onHashed?: (hash: string) => Promise<void> | void;
  } = {},
): Promise<{ entry: AssetManifestEntry; store: 'kv' | 'r2'; isNew: boolean }> {
  const { bytes, hash, size, contentType } = prepared;
  // Dedupe #1: this request already completed an upload for this hash.
  const cached = uploadedHashes.get(hash);
  if (cached) {
    await onHashed?.(hash);
    return { entry: { hash, size }, store: cached, isNew: false };
  }
  // Dedupe #2: another pool task is mid-upload for this hash. Sync
  // `get` → sync `set` below is the atomicity guarantee: no microtask
  // boundary separates the two, so two concurrent callers cannot both
  // observe an empty slot and both schedule fresh uploads.
  const pending = inFlightUploadByHash.get(hash);
  if (pending) {
    await onHashed?.(hash);
    const store = await pending;
    return { entry: { hash, size }, store, isNew: false };
  }
  const key = `assets/${projectId}/${hash}`;
  const uploadTask = (async (): Promise<'kv' | 'r2'> => {
    await onHashed?.(hash);
    const store = await uploadStaticAssetWithRetries(
      kv,
      r2,
      key,
      { bytes, contentType },
      retryDelayMs,
    );
    uploadedHashes.set(hash, store);
    return store;
  })();
  inFlightUploadByHash.set(hash, uploadTask);
  try {
    const store = await uploadTask;
    return { entry: { hash, size }, store, isNew: true };
  } finally {
    // Ownership check: only clear the slot if we are still its owner.
    // A later retry installing a new entry would be preserved — not
    // expected in this flow (the task above is the only writer), but
    // cheap defensive programming.
    if (inFlightUploadByHash.get(hash) === uploadTask) {
      inFlightUploadByHash.delete(hash);
    }
  }
}

/**
 * Stream-read one multipart asset part into memory, hashing incrementally.
 * Used by the worker-backed deploy path, where assets are later uploaded to
 * CF via the asset upload session API and must be held in memory until then.
 * Per-asset residency is bounded only by the 128 MiB Worker isolate memory
 * budget — there is no explicit cap here.
 */
export async function collectBufferedAsset(
  path: string,
  body: ReadableStream<Uint8Array>,
): Promise<{ entry: AssetManifestEntry; hash: string; assetEntry: AssetEntry }> {
  const { bytes, hash, size } = await readAssetBody(body, path);
  return {
    entry: { hash, size },
    hash,
    assetEntry: { bytes, contentType: getContentType(path) },
  };
}

/**
 * Merge a declared (client-sent) asset manifest into a built-from-content manifest.
 * Validates that declared hashes match what we computed; if so, prefers the declared
 * entry verbatim so the upload manifest matches what the CLI sent.
 */
export function applyDeclaredAssetManifest(
  built: Record<string, AssetManifestEntry>,
  declared: Record<string, AssetManifestEntry> | undefined,
): Record<string, AssetManifestEntry> {
  // Always return a fresh object so callers may freely mutate the result
  // (e.g. preflight fill-ins) without reaching back through a shared reference
  // into the builder's state.
  const result: Record<string, AssetManifestEntry> = { ...built };
  if (!declared) {
    return result;
  }
  for (const [path, entry] of Object.entries(built)) {
    const d = declared[path];
    if (
      d &&
      typeof d.hash === 'string' &&
      d.hash.length === 32 &&
      Number.isFinite(d.size) &&
      d.size >= 0
    ) {
      if (d.hash !== entry.hash) {
        throw new AssetHashMismatchError(
          `asset hash mismatch for ${path}: declared ${d.hash}, computed ${entry.hash}`,
        );
      }
      if (d.size === entry.size) {
        result[path] = d;
      }
    }
  }
  return result;
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

export const KV_THRESHOLD = 2 * 1024 * 1024; // 2 MB

async function uploadStaticAssetWithRetries(
  kv: KVNamespace,
  r2: R2Bucket,
  key: string,
  entry: AssetEntry,
  retryDelayMs: number,
): Promise<'kv' | 'r2'> {
  const store = entry.bytes.byteLength >= KV_THRESHOLD ? 'r2' : 'kv';
  let lastErr: unknown;

  for (let attempt = 0; attempt <= STATIC_ASSET_UPLOAD_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
    }

    try {
      if (store === 'r2') {
        await r2.put(key, entry.bytes, {
          httpMetadata: { contentType: entry.contentType },
        });
      } else {
        await kv.put(key, entry.bytes, {
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
  // Collected across all workers so that every in-flight put settles (or
  // stops picking up new entries) before this function returns. Without
  // this, Promise.all would reject on the first worker failure while the
  // remaining workers keep writing bytes in the background, racing any
  // abort-cleanup the caller triggers.
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (firstError === undefined && index < entries.length) {
      const [hash, entry] = entries[index++];
      const key = `assets/${projectId}/${hash}`;
      try {
        const store = await uploadStaticAssetWithRetries(kv, r2, key, entry, retryDelayMs);
        if (store === 'r2') {
          largeHashes.add(hash);
        }
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
        }
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(STATIC_ASSET_UPLOAD_CONCURRENCY, entries.length) }, () =>
      worker(),
    ),
  );
  if (firstError !== undefined) {
    throw firstError;
  }
  return largeHashes;
}

/**
 * Best-effort cleanup of assets that were streamed into KV/R2 before a deploy
 * parse failure. Only deletes hashes that are NOT referenced by any retained
 * deployment, so aborting a retry never evicts content that a previous
 * successful deploy still depends on. Failures are logged and swallowed — the
 * caller is already on the error path and must not mask the underlying cause.
 *
 * Each entry is removed from `uploaded` only after its store successfully
 * drops the key (or, for retained hashes, once we've confirmed it is
 * protected). Entries whose delete throws are left in the map so a later
 * cleanup pass (outer finally retry) can re-attempt them instead of leaking
 * them into KV/R2 permanently.
 */
export async function cleanupStreamedStaticAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  projectId: string,
  uploaded: Map<string, 'kv' | 'r2'>,
  retainedHashes: Set<string>,
  shouldProtectHash?: (hash: string) => Promise<boolean>,
): Promise<void> {
  if (uploaded.size === 0) {
    return;
  }

  // Retained hashes are live in at least one protected deployment — we must
  // not delete them, and they do not need to be retried on the next pass.
  // Iterating uploaded.keys() while deleting is well-defined per ECMAScript:
  // the Map iterator skips entries that were already visited or deleted.
  for (const hash of uploaded.keys()) {
    if (retainedHashes.has(hash)) {
      uploaded.delete(hash);
    }
  }
  if (uploaded.size === 0) {
    return;
  }

  // Targeted per-store deletes. The map records whether each hash landed in
  // KV or R2 so we skip the belt-and-suspenders double-delete and, more
  // importantly, only clear entries that actually succeeded.
  let failureCount = 0;
  for (const [hash, store] of uploaded) {
    const key = `assets/${projectId}/${hash}`;
    try {
      if (await shouldProtectHash?.(hash)) {
        uploaded.delete(hash);
        continue;
      }
      if (store === 'r2') {
        await r2.delete(key);
      } else {
        await kv.delete(key);
      }
      uploaded.delete(hash);
    } catch (err) {
      failureCount++;
      console.warn(
        `[assets] cleanup failed for ${hash} in ${store}`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (failureCount > 0) {
    console.warn(
      `[assets] cleanup after parse failure retained ${failureCount} hash(es) for retry`,
    );
  }
}

/**
 * Delete assets that are no longer referenced by any retained deployment.
 * Deletes from both KV and R2 (content-addressed keys live in one or the other,
 * but we clean both since we don't track which store holds a given hash).
 */
export async function deleteUnreferencedAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  evictedHashes: Array<string>,
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
