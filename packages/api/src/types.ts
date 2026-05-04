import type { InferSelectModel } from 'drizzle-orm';
import type {
  users,
  oauthAccounts,
  projects,
  deployments,
  projectSecrets,
  resources,
  domains,
  platformEvents,
  invitations,
} from './schema.ts';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export type User = InferSelectModel<typeof users>;
export type OAuthAccount = InferSelectModel<typeof oauthAccounts>;
export type Project = InferSelectModel<typeof projects>;
export type Deployment = InferSelectModel<typeof deployments>;
export type DeploymentStatus = Deployment['status'];
export type ProjectSecret = InferSelectModel<typeof projectSecrets>;
export type Resource = InferSelectModel<typeof resources>;
export type Domain = InferSelectModel<typeof domains>;
export type PlatformEvent = InferSelectModel<typeof platformEvents>;
export type Invitation = InferSelectModel<typeof invitations>;

export interface MigrationMeta {
  name: string;
  destructive: boolean;
}

export interface ScheduleMeta {
  name: string;
  cron: string;
}

export interface QueueMeta {
  name: string;
  bindingName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export const SUPPORTED_MANIFEST_VERSIONS = [3];

export interface AssetConfig {
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
}

export interface WebSocketRouteMeta {
  pattern: string;
  filePath: string;
  className: string;
  bindingName?: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
}

export interface WebSocketMigrationMeta {
  tag: string;
  newClasses?: Array<string>;
  deletedClasses?: Array<string>;
}

export interface WebSocketManifestMeta {
  routes: Array<WebSocketRouteMeta>;
  classes: Array<string>;
  migrations?: Array<WebSocketMigrationMeta>;
}

export interface SandboxMigrationMeta {
  tag: string;
  newSqliteClasses?: Array<string>;
  deletedClasses?: Array<string>;
}

export interface SandboxManifestMeta {
  bindingName: string;
  className: string;
  containerName: string;
  image: string;
  instanceType?: string;
  maxInstances?: number;
  migrations?: Array<SandboxMigrationMeta>;
}

/**
 * Manifest header-rule shape. Mirrors `HeaderRule` in `dispatch/src/headers.ts`
 * and the framework-side `HeaderRule` in `packages/void/src/cli/types.ts`.
 * Structural equivalence across the three is pinned by
 * `packages/dispatch/test/unit/framework-contract.test.ts`.
 */
export interface HeaderRule {
  pattern: string;
  headers: Array<[string, string]>;
}

/**
 * Manifest redirect/rewrite rule shape. Mirrors `RedirectRule` in
 * `dispatch/src/routing-rules.ts` and the framework-side `RedirectRule` in
 * `packages/void/src/cli/types.ts`. Structural equivalence across the three
 * is pinned by `packages/dispatch/test/unit/framework-contract.test.ts`.
 */
export interface RedirectRule {
  source: string;
  destination: string;
  status: number;
  /**
   * Optional literal host the rule is scoped to. Authored as an
   * `https://host/path` prefix on the source in `_redirects` (or as the
   * `host` key in a `routing.redirects` object form in `void.json`); the
   * framework parser splits the URL and stores `host` here, leaving
   * `source` as the path-only pattern. Lowercase-normalized at parse time.
   * The platform validates that `host` is bound to the project at deploy
   * ingest, and dispatch matches it byte-for-byte against `url.hostname`
   * at request time. Optional — path-only rules apply to every host bound
   * to the project.
   */
  host?: string;
}

/**
 * Statuses accepted on manifest `redirectRules` entries at ingest:
 * 200 for pre-asset "force" rewrites, 3xx for redirects. Superset of the
 * framework's `VALID_REDIRECT_STATUSES` (`framework/packages/void/src/config.ts`) —
 * the 200 case is encoded by which array the rule lives in, not a separate
 * wire field. Keep in sync with the framework's 3xx list on HTTP-spec
 * changes; a runtime cross-submodule pin isn't viable because the framework's
 * `config.ts` pulls `node:fs` / `node:path`, which don't resolve against
 * dispatch's `@cloudflare/workers-types`-only tsconfig.
 */
export const MANIFEST_REDIRECT_RULE_STATUSES: ReadonlySet<number> = new Set([
  200, 301, 302, 303, 307, 308,
]);

export interface DeployManifest {
  version: number;
  auth?: boolean;
  bindings: {
    d1?: Array<string>;
    kv?: Array<string>;
    r2?: Array<string>;
    ai?: boolean;
    hyperdrive?: Array<string>;
  };
  migrations?: {
    dialect: 'sqlite' | 'postgresql';
    pending: number;
  };
  schedules?: Array<ScheduleMeta>;
  queues?: Array<QueueMeta>;
  ssr?: boolean;
  framework?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  revalidate?: number | Record<string, number>;
  /**
   * Per-pathname allowlist of query params that participate in the ISR
   * variant key on a rewrite. Default (no entry / no allowlist) drops
   * every param so an attacker can't fan out cache slots by varying
   * `?utm`/`?cb`/etc. Path patterns are matched against the user-facing
   * (pre-rewrite) pathname; first match wins. A `*` entry acts as a
   * catch-all default.
   */
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<RedirectRule>;
  fallbackRules?: Array<RedirectRule>;
  websocket?: WebSocketManifestMeta;
  sandbox?: SandboxManifestMeta;
}

export type DeployEvent =
  | { event: 'start'; deploymentId: string }
  | { event: 'heartbeat'; deploymentId?: string; step: string }
  | { event: 'asset_upload'; total: number; new: number; cached: number }
  | { event: 'asset_upload_done' }
  | { event: 'provisioning'; bindings: Array<string> }
  | { event: 'provisioning_done' }
  | { event: 'migration_start'; pending: number }
  | { event: 'migration'; name: string; durationMs: number }
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
    }
  | { event: 'error'; message: string; step: string };
