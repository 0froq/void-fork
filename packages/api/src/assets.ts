import type { AssetConfig } from "./types";

interface AssetManifestEntry {
  hash: string;
  size: number;
}

interface AssetEntry {
  blob: Blob;
  contentType: string;
}

interface UploadSessionResponse {
  result: {
    jwt: string;
    buckets: string[][];
  };
}

/**
 * Step 1: Create an asset upload session with CF.
 * Sends the asset manifest (path → {hash, size}) and receives a completion JWT
 * plus "buckets" — groups of hashes that CF needs uploaded.
 */
export async function createAssetUploadSession(
  accountId: string,
  apiToken: string,
  namespace: string,
  workerName: string,
  manifest: Record<string, AssetManifestEntry>,
): Promise<{ jwt: string; buckets: string[][] }> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${workerName}/assets-upload-session`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ manifest }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`asset upload session failed: ${error}`);
  }

  const data = (await response.json()) as UploadSessionResponse;
  return { jwt: data.result.jwt, buckets: data.result.buckets };
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
  apiToken: string,
  jwt: string,
  buckets: string[][],
  assetsByHash: Map<string, AssetEntry>,
): Promise<string> {
  let completionJwt = "";
  for (const bucket of buckets) {
    const formData = new FormData();
    for (const hash of bucket) {
      const entry = assetsByHash.get(hash);
      if (!entry) continue;
      const buffer = await entry.blob.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      formData.append(hash, new File([base64], hash, { type: entry.contentType }), hash);
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`asset upload failed: ${error}`);
    }

    const data = (await response.json()) as { result: { jwt?: string } };
    if (data.result?.jwt) {
      completionJwt = data.result.jwt;
    }
  }
  return completionJwt;
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
export async function collectAssets(
  formData: FormData,
): Promise<{
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

/** Passthrough worker script for static-only deploys. */
export const PASSTHROUGH_WORKER = `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`;
