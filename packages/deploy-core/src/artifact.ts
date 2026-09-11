import type { DeployManifest } from './index.ts';

/** Content-addressed metadata for one static asset in a deployment artifact. */
export type DeployAssetManifestEntry = {
  blake3: string;
  md5: string;
  size: number;
  /** @deprecated v1 alias of `blake3`. */
  hash: string;
};

/** Target-neutral output of packaging a Void application for deployment. */
export type DeployArtifact = {
  manifest: DeployManifest;
  assetManifest: Record<string, DeployAssetManifestEntry>;
  /** Worker module bytes keyed by relative path, base64-encoded for transport. */
  workerFiles?: Record<string, string>;
};

export type DeploySourceMetadata = {
  source: string | null;
  commit: string | null;
  repositoryUrl: string | null;
  commitUrl: string | null;
  gitRef: string | null;
};

/** JSON payload accepted by the managed deployment API. */
export type DeployUploadPayload = DeployArtifact &
  DeploySourceMetadata & {
    preflight: 'true' | null;
  };

/** Asset declaration accepted by the direct-upload URL endpoint. */
export type DeployAssetUploadRequest = {
  blake3: string;
  md5: string;
  size: number;
  contentType: string;
};
