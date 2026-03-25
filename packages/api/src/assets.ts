import type { AssetConfig } from "./types";
import { retryWithBackoff } from "./cf-api";

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
const ASSET_UPLOAD_COMPLETE_MAX_RETRIES = 3;
const ASSET_UPLOAD_COMPLETE_RETRY_DELAY_MS = 1000;

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
        throw new Error(`asset upload session failed: ${error}`);
      }

      const text = await response.text();
      const data = tryParseJson<UploadSessionResponse>(text);
      if (data?.result?.jwt && Array.isArray(data.result.buckets)) {
        return { jwt: data.result.jwt, buckets: data.result.buckets };
      }
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
 * Each bucket is a group of hashes that CF wants uploaded together.
 * Files are sent as base64-encoded multipart form data with ?base64=true.
 * The Content-Type on each form part is preserved by CF when serving the asset.
 * Returns the completion JWT from the final upload response.
 */
export async function uploadAssetBuckets(
  accountId: string,
  jwt: string,
  buckets: string[][],
  assetsByHash: Map<string, AssetEntry>,
  { retryDelayMs = ASSET_UPLOAD_COMPLETE_RETRY_DELAY_MS }: { retryDelayMs?: number } = {},
): Promise<string> {
  let completionJwt = jwt;
  for (const bucket of buckets) {
    const formData = new FormData();
    for (const hash of bucket) {
      const entry = assetsByHash.get(hash);
      if (!entry) continue;
      const buffer = await entry.blob.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      formData.append(hash, new File([base64], hash, { type: entry.contentType }), hash);
    }

    completionJwt = await postAssetUpload(accountId, completionJwt, formData);
  }

  // When all assets are cached (empty buckets), CF still requires an upload
  // call to exchange the session JWT for a completion JWT (CF error 10021).
  // Wrapped in retryWithBackoff because CF edge nodes sometimes return
  // plain-text instead of JSON — without retry the fallback would silently
  // return the session JWT, reintroducing the original bug.
  if (buckets.length === 0) {
    completionJwt = await retryWithBackoff(
      async () => {
        const result = await postAssetUpload(accountId, jwt, new FormData());
        return result !== jwt ? result : undefined;
      },
      {
        maxRetries: ASSET_UPLOAD_COMPLETE_MAX_RETRIES,
        delayMs: retryDelayMs,
        errorMessage: "asset upload completion returned no JWT after retries",
      },
    );
  }

  return completionJwt;
}

async function postAssetUpload(accountId: string, jwt: string, body: FormData): Promise<string> {
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
    const error = await response.text();
    throw new Error(`asset upload failed: ${error}`);
  }

  const text = await response.text();
  const data = tryParseJson<{ result?: { jwt?: string } }>(text);
  return data?.result?.jwt ?? jwt;
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
