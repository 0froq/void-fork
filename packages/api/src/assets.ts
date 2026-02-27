import type { AssetConfig } from "./types";

interface AssetManifestEntry {
  hash: string;
  size: number;
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
 * Files are sent as base64-encoded multipart form entries.
 */
export async function uploadAssetBuckets(
  accountId: string,
  apiToken: string,
  jwt: string,
  buckets: string[][],
  assetsByHash: Map<string, Blob>,
): Promise<void> {
  await Promise.all(
    buckets.map(async (bucket) => {
      const formData = new FormData();
      for (const hash of bucket) {
        const blob = assetsByHash.get(hash);
        if (!blob) continue;
        formData.append(hash, blob, hash);
      }

      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload`,
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
    }),
  );
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
 * Collect assets from FormData and build the CF asset manifest + hash→blob map.
 */
export async function collectAssets(
  formData: FormData,
): Promise<{ manifest: Record<string, AssetManifestEntry>; assetsByHash: Map<string, Blob> }> {
  const manifest: Record<string, AssetManifestEntry> = {};
  const assetsByHash = new Map<string, Blob>();

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("asset:")) {
      const path = "/" + key.slice("asset:".length);
      const blob = value as Blob;
      const buffer = await blob.arrayBuffer();
      const hash = await computeAssetHash(buffer);
      manifest[path] = { hash, size: buffer.byteLength };
      assetsByHash.set(hash, blob);
    }
  }

  return { manifest, assetsByHash };
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
