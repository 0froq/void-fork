import type { RedirectRule } from '@void/deploy-core';

export type {
  AssetConfig,
  DeployArtifact,
  DeployAssetManifestEntry,
  DeployAssetUploadRequest,
  DeployEvent,
  DeployManifest,
  DeploySourceMetadata,
  DeployUploadPayload,
  HeaderRule,
  LiveManifestMeta,
  LiveMigrationMeta,
  MigrationMeta,
  QueueMeta,
  RedirectRule,
  SandboxManifestMeta,
  SandboxMigrationMeta,
  ScheduleMeta,
  WebSocketManifestMeta,
  WebSocketMigrationMeta,
  WebSocketRouteMeta,
} from '@void/deploy-core';

/** CLI- and development-only routing metadata, stripped before serialization. */
export type DevRedirectRule = RedirectRule & {
  force?: boolean;
  origin?: string;
};
