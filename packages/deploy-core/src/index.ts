export const SUPPORTED_MANIFEST_VERSIONS: ReadonlyArray<number> = [3];

export type MigrationMeta = {
  name: string;
  destructive: boolean;
};

export type ScheduleMeta = {
  name: string;
  cron: string;
};

export type QueueMeta = {
  name: string;
  bindingName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  retryDelay?: number;
};

export type HeaderRule = {
  pattern: string;
  headers: Array<[string, string]>;
};

/** Public wire shape of a redirect, rewrite, or fallback rule. */
export type RedirectRule = {
  source: string;
  destination: string;
  status: number;
  /** Lowercase literal hostname. Path-only rules omit this field. */
  host?: string;
};

export const MANIFEST_REDIRECT_RULE_STATUSES: ReadonlySet<number> = new Set([
  200, 301, 302, 303, 307, 308,
]);

export type AssetConfig = {
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
  /** Native Cloudflare Workers Assets routing; ignored by managed dispatch. */
  run_worker_first?: boolean | Array<string>;
};

export type WebSocketRouteMeta = {
  pattern: string;
  filePath: string;
  className: string;
  bindingName?: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
};

export type WebSocketMigrationMeta = {
  tag: string;
  newClasses?: ReadonlyArray<string>;
  deletedClasses?: ReadonlyArray<string>;
};

export type WebSocketManifestMeta = {
  routes: ReadonlyArray<WebSocketRouteMeta>;
  classes: ReadonlyArray<string>;
  migrations?: ReadonlyArray<WebSocketMigrationMeta>;
};

export type SandboxMigrationMeta = {
  tag: string;
  newSqliteClasses?: ReadonlyArray<string>;
  deletedClasses?: ReadonlyArray<string>;
};

export type SandboxManifestMeta = {
  bindingName: string;
  className: string;
  containerName: string;
  image: string;
  instanceType?: string;
  maxInstances?: number;
  migrations?: ReadonlyArray<SandboxMigrationMeta>;
};

export type LiveMigrationMeta = {
  tag: string;
  newSqliteClasses?: ReadonlyArray<string>;
};

export type LiveManifestMeta = {
  bindingName: string;
  className: string;
  storage: 'sqlite';
  classes: ReadonlyArray<string>;
  migrations?: ReadonlyArray<LiveMigrationMeta>;
};

export type DeployManifest = {
  version: number;
  assetManifestVersion?: 1 | 2;
  auth?: boolean;
  bindings: {
    d1?: Array<string>;
    kv?: Array<string>;
    r2?: Array<string>;
    ai?: boolean;
    hyperdrive?: Array<string>;
  };
  migrations?: {
    dialect: 'sqlite' | 'postgresql' | 'mysql';
    pending: number;
    protocolVersion?: 2;
    classifierVersion?: number;
    migrationListHash?: string;
    stability?: 'stable' | 'legacy';
  };
  schedules?: Array<ScheduleMeta>;
  queues?: Array<QueueMeta>;
  ssr?: boolean;
  framework?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  revalidate?: number | Record<string, number>;
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  pages?: Array<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  limits?: { cpuMs?: number };
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<RedirectRule>;
  fallbackRules?: Array<RedirectRule>;
  websocket?: WebSocketManifestMeta;
  sandbox?: SandboxManifestMeta;
  live?: LiveManifestMeta;
};

export type DeployEvent =
  | { event: 'start'; deploymentId: string }
  | { event: 'heartbeat'; deploymentId?: string; step: string }
  | { event: 'asset_upload'; total: number; new: number; cached: number }
  | { event: 'asset_upload_done' }
  | { event: 'provisioning'; bindings: Array<string> }
  | { event: 'provisioning_done' }
  | { event: 'worker_readiness' }
  | { event: 'migration_start'; pending: number }
  | { event: 'migration'; name: string; durationMs: number; stability?: 'stable' | 'legacy' }
  | { event: 'migration_warning'; message: string }
  | { event: 'worker_upload'; modules: number }
  | { event: 'worker_upload_done' }
  | { event: 'queue_setup'; queues: Array<string> }
  | { event: 'queue_consumer_conflict'; queue: string; ownerScript: string }
  | { event: 'prerender'; pages: number }
  | { event: 'prerender_done' }
  | {
      event: 'done';
      deployment: string;
      url: string;
      urls: Array<string>;
      assets: number;
      workers: number;
      migrations?: number;
      published?: boolean;
    }
  | { event: 'error'; message: string; step: string };
