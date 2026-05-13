import { isrCacheKey, isrCachePrefix } from '@voidcloud/isr-shared';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  AssetHashMismatchError,
  computeAssetHash,
  createAssetUploadSession,
  deleteWorkerBundle,
  normalizeForCfAssetSession,
  sweepProjectAssetOrphans,
  uploadAssetBuckets,
  buildAssetMetadata,
  uploadStaticAssets,
  deleteUnreferencedAssets,
  getContentType,
  persistWorkerBundle,
  type AssetEntry,
  type AssetManifestEntry,
} from '../assets.ts';
import { deleteDispatchScript, retryWithBackoff } from '../cf-api.ts';
import { R2_CONCURRENCY, uploadPool } from '../concurrency.ts';
import { SITE_DOMAIN } from '../constants.ts';
import { DEFAULT_DASHBOARD_URL } from '../constants.ts';
import { clearCronScheduler, syncCronScheduler } from '../cron-scheduler-client.ts';
import {
  getProject,
  getDeployment,
  createDeployment,
  updateDeploymentManifest,
  updateDeploymentStatus,
  updateProjectType,
  updateProjectWebSocketVersion,
  getDomainsByProjectId,
  countUserDeploymentsToday,
  getActiveDeployment,
  getInFlightDeploymentsExcluding,
  getLastLiveAssetManifest,
  setActiveDeployment,
  markDeploymentRetained,
  markDeploymentBundleStored,
  setAppliedMigrations,
  getRetainedDeployments,
  getRetainedDeploymentsExcluding,
  getProjectSecrets,
  upsertProjectSecret,
  CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES,
  type Db,
} from '../db.ts';
import { sendDeployFailedEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { checkCliVersionOrRespond } from '../middleware/cli-version.ts';
import { createDeployLogger, type DeployLogger } from '../observability/logger.ts';
import {
  BETTER_AUTH_SECRET_NAME,
  decryptProjectSecret,
  generateManagedAuthSecret,
  encryptProjectSecret,
} from '../project-secrets.ts';
import { addQueueConsumer } from '../provisioning/cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  perDeployContainerApplicationName,
  provisionPerDeployContainer,
} from '../provisioning/containers.ts';
import { provisionBindings } from '../provisioning/provision.ts';
import { presignAssetPut } from '../r2-presign.ts';
import { buildRoutingJson, buildStaticRoutingJson } from '../routing.ts';
import { deployments } from '../schema.ts';
import { getPlanLimits, isWithinLimit, STATIC_RETENTION_LIMIT } from '../tiers.ts';
import {
  MANIFEST_REDIRECT_RULE_STATUSES,
  SUPPORTED_MANIFEST_VERSIONS,
  type DeployManifest,
  type DeployEvent,
  type DeploymentStatus,
  type LiveMigrationMeta,
  type SandboxMigrationMeta,
  type WebSocketMigrationMeta,
} from '../types.ts';

const DEFAULT_DISPATCH_NAMESPACE = 'void-users';
const DEFAULT_TAIL_SERVICE_NAME = 'void-tail';

// CF's worker script size limit (free plan 1 MiB, paid plan 10 MiB compressed).
// Enforced per worker module so a single runaway worker file cannot OOM the
// request before the upload to CF ever happens.
const MAX_WORKER_FILE_BYTES = 32 * 1024 * 1024; // 32 MiB
/**
 * Detect the known CF WfP bug where APIs return plain text about asset state
 * instead of JSON. CF returns different messages depending on propagation state
 * (e.g. "Assets have already been uploaded", "Assets have not yet been deployed").
 * Valid JSON always starts with `{` or `[`, so `startsWith` avoids false positives.
 */
function isCfAssetPlainText(text: string): boolean {
  return text.trimStart().startsWith('Assets have');
}

type UserWorkerMigrationResult = {
  ok: boolean;
  migrations: Array<{
    name: string;
    applied: boolean;
    durationMs: number;
    error?: string;
  }>;
  error?: string;
};

function formatMigrationFailure(result: UserWorkerMigrationResult): string {
  const failedMigration = result.migrations.find((migration) => migration.error);
  if (failedMigration?.error) {
    const detailed = `migration ${failedMigration.name} failed: ${failedMigration.error}`;
    return result.error?.includes(failedMigration.error) ? result.error : detailed;
  }
  return result.error ?? 'unknown error';
}

/**
 * Decode a base64 string to bytes with the lowest peak residency the
 * runtime allows. Prefers the (TC39 stage-4) `Uint8Array.fromBase64` helper
 * which performs the decode in a single allocation; falls back to the
 * `atob` + per-byte copy path on runtimes that don't expose it (notably
 * Node, where the integration tests run — the production CF Workers compat
 * date is 2026-02-12 and ships the helper natively).
 *
 * For a 32 MiB module the fast path drops peak residency from
 * roughly `raw + bin + decoded ≈ 86 + 64 + 32 = 182 MiB` to
 * `raw + decoded ≈ 86 + 32 = 118 MiB`, which fits under the 128 MiB
 * isolate cap with margin. The fallback path matches the previous behaviour.
 */
function decodeBase64ToBytes(raw: string): Uint8Array {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array })
    .fromBase64;
  if (typeof fromBase64 === 'function') {
    return fromBase64(raw);
  }
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

const CF_RETRY = { maxRetries: 3, delayMs: 1000 };
// Readiness probe: confirms the new worker is live in the dispatch namespace
// before dispatching migrations. Absorbs CF's WfP propagation delay.
// Backoff: 0 + 1 + 2 + 4 + 8 + 16 + 32 = ~63s max window.
const CF_READINESS_RETRY = { maxRetries: 6, delayMs: 1000 };
// Migration dispatch: propagation lag is handled by the readiness probe,
// so this only retries genuine transient failures (e.g. network blips).
const CF_MIGRATION_RETRY = { maxRetries: 2, delayMs: 1000 };
// Container DELETE retry budget for catch-handler cleanup (pre-routing
// failure + teardown-race rollback). One retry at 500ms covers transient CF
// failures (502/503/network blips) during the cancellation window without
// stretching cancellation latency. Errors are still swallowed by the caller
// after the retry budget is exhausted because the orphan-recovery pass in
// `cleanupCriticalResources` will reap any straggler on the next teardown.
const CF_CONTAINER_DELETE_RETRY = { maxRetries: 1, delayMs: 500 };

/**
 * Wrap `deleteContainerApplicationIdempotent` with a small retry budget for
 * catch-path cleanup. Returns `true` on success, `false` if every attempt
 * threw — the caller decides whether to swallow the failure (currently:
 * always swallow + log; teardown's orphan recovery is the safety net).
 */
async function deleteContainerApplicationWithRetry(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<boolean> {
  let lastErr: unknown;
  try {
    await retryWithBackoff(
      async () => {
        try {
          await deleteContainerApplicationIdempotent(accountId, apiToken, applicationId);
          return true;
        } catch (err) {
          lastErr = err;
          return undefined; // signal retry
        }
      },
      {
        maxRetries: CF_CONTAINER_DELETE_RETRY.maxRetries,
        delayMs: CF_CONTAINER_DELETE_RETRY.delayMs,
        errorMessage: `failed to delete container application ${applicationId}`,
      },
    );
    return true;
  } catch {
    if (lastErr) {
      console.error(`[deploy] failed to clean up container application ${applicationId}:`, lastErr);
    }
    return false;
  }
}

const app = new Hono<ApiEnv>();

function sameClassSet(a: Array<string>, b: Array<string>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sortUnique(values: Array<string> | undefined): Array<string> {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b));
}

// Runtime shape validation for incoming deploy manifests. Downstream code
// indexes deeply into the manifest (bindings.d1, queues[i].name,
// websocket.classes, etc.) without re-guarding, so a malformed-but-JSON-valid
// payload would otherwise crash with a 500 — sometimes after a deployment row
// or CF resources were created. Everything the deploy pipeline reads must be
// validated here BEFORE createDeployment runs.
// Caps on user-supplied routing rule lists. Each rule compiles a regex per
// request in dispatch (see `routing-rules.ts`), so an unbounded list lets a
// 100k-entry manifest exhaust CPU on every request to the project. The limit
// is per-list (redirect + fallback are independent), well above what real
// frameworks emit (Vercel/Netlify both ship in the low thousands at most),
// and validated at deploy ingest so dispatch never sees an oversized list.
export const MAX_ROUTING_RULES = 2000;
export const MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES = MAX_ROUTING_RULES;

/**
 * Strict literal-hostname regex used to validate `redirectRules[].host` /
 * `fallbackRules[].host` on the deploy manifest. Mirrors the regex in
 * `routes/domains.ts` (custom-domain create endpoint) — the source of truth
 * for what counts as a valid project-owned hostname. Rejects scheme prefixes,
 * ports, paths, whitespace, control chars, wildcards, single-label hosts,
 * IPv4 literals, and userinfo. Hostnames are lowercased before testing so
 * the same byte-exact form is what dispatch compares against `url.hostname`
 * (also lowercase per WHATWG).
 */
const LITERAL_HOSTNAME_REGEX = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Validate and lowercase-normalize an optional `host` field on a redirect or
 * fallback rule. Mutates `ro.host` in place so the persisted manifest carries
 * the canonical form. Returns an error message string on failure, or `null`
 * on success (including the absent-field case).
 */
function validateRuleHost(
  ro: Record<string, unknown>,
  ruleKind: 'redirectRules' | 'fallbackRules',
  sourceRef: string,
): string | null {
  if (ro.host === undefined) {
    return null;
  }
  if (typeof ro.host !== 'string') {
    return `invalid manifest shape: ${ruleKind} entry ${sourceRef} host must be a string`;
  }
  const normalized = ro.host.toLowerCase();
  if (!LITERAL_HOSTNAME_REGEX.test(normalized)) {
    return `invalid manifest shape: ${ruleKind} entry ${sourceRef} host must be a literal hostname (e.g. "www.example.com"; no scheme, port, path, or wildcards): ${JSON.stringify(ro.host)}`;
  }
  ro.host = normalized;
  return null;
}

export function validateManifestShape(parsed: unknown): string | null {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'invalid manifest shape: expected a JSON object';
  }
  const manifest = parsed as Record<string, unknown>;

  if (
    manifest.bindings == null ||
    typeof manifest.bindings !== 'object' ||
    Array.isArray(manifest.bindings)
  ) {
    return 'invalid manifest shape: bindings must be an object';
  }
  const bindings = manifest.bindings as Record<string, unknown>;
  for (const key of ['d1', 'kv', 'r2', 'hyperdrive'] as const) {
    const v = bindings[key];
    if (v === undefined) {
      continue;
    }
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      return `invalid manifest shape: bindings.${key} must be an array of strings`;
    }
  }

  if (manifest.queues !== undefined) {
    if (!Array.isArray(manifest.queues)) {
      return 'invalid manifest shape: queues must be an array';
    }
    for (const q of manifest.queues) {
      if (q == null || typeof q !== 'object' || Array.isArray(q)) {
        return 'invalid manifest shape: queues entries must be objects';
      }
      const qo = q as Record<string, unknown>;
      if (typeof qo.name !== 'string' || typeof qo.bindingName !== 'string') {
        return 'invalid manifest shape: queues entries must have string name and bindingName';
      }
      for (const tuning of [
        'maxBatchSize',
        'maxBatchTimeout',
        'maxRetries',
        'retryDelay',
      ] as const) {
        const v = qo[tuning];
        if (v === undefined) {
          continue;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return `invalid manifest shape: queues entry ${tuning} must be a finite number`;
        }
      }
    }
  }

  if (manifest.schedules !== undefined) {
    if (!Array.isArray(manifest.schedules)) {
      return 'invalid manifest shape: schedules must be an array';
    }
    for (const s of manifest.schedules) {
      if (s == null || typeof s !== 'object' || Array.isArray(s)) {
        return 'invalid manifest shape: schedules entries must be objects';
      }
      const so = s as Record<string, unknown>;
      if (typeof so.name !== 'string' || typeof so.cron !== 'string') {
        return 'invalid manifest shape: schedules entries must have string name and cron';
      }
    }
  }

  if (manifest.prerender !== undefined) {
    if (
      !Array.isArray(manifest.prerender) ||
      !manifest.prerender.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: prerender must be an array of strings';
    }
  }

  if (manifest.vars !== undefined) {
    if (
      manifest.vars == null ||
      typeof manifest.vars !== 'object' ||
      Array.isArray(manifest.vars)
    ) {
      return 'invalid manifest shape: vars must be an object';
    }
    for (const [k, v] of Object.entries(manifest.vars as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return `invalid manifest shape: vars.${k} must be a string`;
      }
    }
  }

  if (manifest.migrations !== undefined) {
    if (
      manifest.migrations == null ||
      typeof manifest.migrations !== 'object' ||
      Array.isArray(manifest.migrations)
    ) {
      return 'invalid manifest shape: migrations must be an object';
    }
    const mig = manifest.migrations as Record<string, unknown>;
    // `dialect` and `pending` are read unconditionally by the migration
    // dispatch path (`manifest.migrations.pending > 0`). A wrong-typed value
    // would reach the CF migration runner and crash mid-deploy.
    if (mig.dialect !== undefined) {
      const allowed = ['sqlite', 'postgresql'];
      if (typeof mig.dialect !== 'string' || !allowed.includes(mig.dialect)) {
        return `invalid manifest shape: migrations.dialect must be one of ${allowed.join(', ')}`;
      }
    }
    if (mig.pending !== undefined) {
      if (typeof mig.pending !== 'number' || !Number.isInteger(mig.pending) || mig.pending < 0) {
        return 'invalid manifest shape: migrations.pending must be a non-negative integer';
      }
    }
  }

  if (manifest.auth !== undefined && typeof manifest.auth !== 'boolean') {
    return 'invalid manifest shape: auth must be a boolean';
  }

  if (manifest.ssr !== undefined && typeof manifest.ssr !== 'boolean') {
    return 'invalid manifest shape: ssr must be a boolean';
  }

  for (const key of [
    'workerMain',
    'compatibilityDate',
    'hashedAssetsPrefix',
    'framework',
  ] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'string') {
      return `invalid manifest shape: ${key} must be a string`;
    }
  }

  if (manifest.assetManifestVersion !== undefined) {
    // Direct-to-R2 deploys require v2 (declares blake3 + md5 + size per asset).
    // The handler enforces v2 with its own error message; this shape check
    // accepts 1 here so the layered error is the one users see.
    if (manifest.assetManifestVersion !== 1 && manifest.assetManifestVersion !== 2) {
      return 'invalid manifest shape: assetManifestVersion must be 1 or 2';
    }
  }

  if (manifest.compatibilityFlags !== undefined) {
    if (
      !Array.isArray(manifest.compatibilityFlags) ||
      !manifest.compatibilityFlags.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: compatibilityFlags must be an array of strings';
    }
  }

  if (manifest.type !== undefined) {
    const allowed = ['void', 'spa', 'static', 'framework'];
    if (typeof manifest.type !== 'string' || !allowed.includes(manifest.type)) {
      return `invalid manifest shape: type must be one of ${allowed.join(', ')}`;
    }
  }

  if (manifest.assetConfig !== undefined) {
    if (
      manifest.assetConfig == null ||
      typeof manifest.assetConfig !== 'object' ||
      Array.isArray(manifest.assetConfig)
    ) {
      return 'invalid manifest shape: assetConfig must be an object';
    }
    const ac = manifest.assetConfig as Record<string, unknown>;
    if (
      ac.not_found_handling !== undefined &&
      !['none', 'single-page-application', '404-page'].includes(ac.not_found_handling as string)
    ) {
      return 'invalid manifest shape: assetConfig.not_found_handling must be one of none, single-page-application, 404-page';
    }
    if (
      ac.html_handling !== undefined &&
      !['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'].includes(
        ac.html_handling as string,
      )
    ) {
      return 'invalid manifest shape: assetConfig.html_handling must be one of auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none';
    }
  }

  if (manifest.revalidate !== undefined) {
    if (typeof manifest.revalidate === 'number') {
      // ok
    } else if (
      manifest.revalidate == null ||
      typeof manifest.revalidate !== 'object' ||
      Array.isArray(manifest.revalidate)
    ) {
      return 'invalid manifest shape: revalidate must be a number or object';
    } else {
      for (const [k, v] of Object.entries(manifest.revalidate as Record<string, unknown>)) {
        if (typeof v !== 'number') {
          return `invalid manifest shape: revalidate.${k} must be a number`;
        }
      }
    }
  }

  if (manifest.headerRules !== undefined) {
    if (!Array.isArray(manifest.headerRules)) {
      return 'invalid manifest shape: headerRules must be an array';
    }
    for (const rule of manifest.headerRules) {
      if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) {
        return 'invalid manifest shape: headerRules entries must be objects';
      }
      const ro = rule as Record<string, unknown>;
      if (typeof ro.pattern !== 'string') {
        return 'invalid manifest shape: headerRules entries must have a string pattern';
      }
      if (!Array.isArray(ro.headers)) {
        return 'invalid manifest shape: headerRules entries must have a headers array';
      }
      for (const pair of ro.headers) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== 'string' ||
          typeof pair[1] !== 'string'
        ) {
          return 'invalid manifest shape: headerRules headers entries must be [name, value] string pairs';
        }
      }
    }
  }

  // redirectRules is the pre-asset rule list. `status: 200` means a force
  // rewrite (internal URL rewrite, no Location header); `status: 3xx` means a
  // redirect. Destinations may not contain `?` — request query is merged
  // separately at dispatch time (see `mergeQueryIntoLocation`).
  if (manifest.redirectRules !== undefined) {
    if (!Array.isArray(manifest.redirectRules)) {
      return 'invalid manifest shape: redirectRules must be an array';
    }
    if (manifest.redirectRules.length > MAX_ROUTING_RULES) {
      return `invalid manifest shape: redirectRules has ${manifest.redirectRules.length} entries, exceeds the ${MAX_ROUTING_RULES} per-list limit`;
    }
    for (const rule of manifest.redirectRules) {
      if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) {
        return 'invalid manifest shape: redirectRules entries must be objects';
      }
      const ro = rule as Record<string, unknown>;
      if (
        typeof ro.source !== 'string' ||
        typeof ro.destination !== 'string' ||
        typeof ro.status !== 'number'
      ) {
        return 'invalid manifest shape: redirectRules entries must have string source, string destination, and numeric status';
      }
      // `JSON.stringify` safely quotes and escapes the user-supplied source
      // string in the error message (handles embedded quotes, newlines, etc).
      const sourceRef = JSON.stringify(ro.source as string);
      if (!MANIFEST_REDIRECT_RULE_STATUSES.has(ro.status)) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} status must be one of ${[...MANIFEST_REDIRECT_RULE_STATUSES].join(', ')} (200 = rewrite, 3xx = redirect)`;
      }
      // Rewrites (status=200) must stay internal: no query string, path-absolute,
      // and not protocol-relative (`//evil.com/x` parses cross-origin). 3xx
      // redirects may include query strings and external Location values.
      const destination = ro.destination as string;
      const isRewrite = ro.status === 200;
      if (isRewrite && destination.includes('?')) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} destination must not contain a query string when status is 200`;
      }
      if (isRewrite && !destination.startsWith('/')) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} destination must be path-absolute (start with "/") when status is 200`;
      }
      if (isRewrite && destination.startsWith('//')) {
        return `invalid manifest shape: redirectRules entry ${sourceRef} destination must not start with "//" (protocol-relative URLs parse cross-origin; use a single-slash path-absolute destination)`;
      }
      const hostError = validateRuleHost(ro, 'redirectRules', sourceRef);
      if (hostError) {
        return hostError;
      }
    }
  }

  // revalidateQueryAllowlist gates which query params participate in the
  // ISR variant key on a rewrite. Shape: `{ "<pathPattern>": ["param", …] }`.
  // The default (no entry / no allowlist) drops every param so a fanout
  // attack via `?utm=…`/`?cb=…` can't multiply cache slots. The validator
  // only enforces shape; semantic correctness (does the pattern match a
  // real route?) is the user's responsibility.
  if (manifest.revalidateQueryAllowlist !== undefined) {
    if (
      manifest.revalidateQueryAllowlist == null ||
      typeof manifest.revalidateQueryAllowlist !== 'object' ||
      Array.isArray(manifest.revalidateQueryAllowlist)
    ) {
      return 'invalid manifest shape: revalidateQueryAllowlist must be an object';
    }
    const entries = Object.entries(manifest.revalidateQueryAllowlist as Record<string, unknown>);
    if (entries.length > MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES) {
      return `invalid manifest shape: revalidateQueryAllowlist has ${entries.length} entries, exceeds the ${MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES} entry limit`;
    }
    for (const [pattern, value] of entries) {
      if (pattern === '') {
        return 'invalid manifest shape: revalidateQueryAllowlist must not include an empty pattern';
      }
      if (!Array.isArray(value)) {
        return `invalid manifest shape: revalidateQueryAllowlist entry ${JSON.stringify(pattern)} must be an array of strings`;
      }
      for (const param of value) {
        if (typeof param !== 'string') {
          return `invalid manifest shape: revalidateQueryAllowlist entry ${JSON.stringify(pattern)} must contain only strings`;
        }
      }
    }
  }

  // fallbackRules fire after the static asset resolver 404s. Rewrites only,
  // so every entry carries the same internal-destination constraints as a
  // status=200 redirectRule.
  if (manifest.fallbackRules !== undefined) {
    if (!Array.isArray(manifest.fallbackRules)) {
      return 'invalid manifest shape: fallbackRules must be an array';
    }
    if (manifest.fallbackRules.length > MAX_ROUTING_RULES) {
      return `invalid manifest shape: fallbackRules has ${manifest.fallbackRules.length} entries, exceeds the ${MAX_ROUTING_RULES} per-list limit`;
    }
    for (const rule of manifest.fallbackRules) {
      if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) {
        return 'invalid manifest shape: fallbackRules entries must be objects';
      }
      const ro = rule as Record<string, unknown>;
      if (
        typeof ro.source !== 'string' ||
        typeof ro.destination !== 'string' ||
        typeof ro.status !== 'number'
      ) {
        return 'invalid manifest shape: fallbackRules entries must have string source, string destination, and numeric status';
      }
      const sourceRef = JSON.stringify(ro.source as string);
      if (ro.status !== 200) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} status must be 200 (fallbacks are rewrites only)`;
      }
      const destination = ro.destination as string;
      if (destination.includes('?')) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} destination must not contain a query string`;
      }
      if (!destination.startsWith('/')) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} destination must be path-absolute (start with "/")`;
      }
      if (destination.startsWith('//')) {
        return `invalid manifest shape: fallbackRules entry ${sourceRef} destination must not start with "//" (protocol-relative URLs parse cross-origin; use a single-slash path-absolute destination)`;
      }
      const hostError = validateRuleHost(ro, 'fallbackRules', sourceRef);
      if (hostError) {
        return hostError;
      }
    }
  }

  if (manifest.websocket !== undefined) {
    if (
      manifest.websocket == null ||
      typeof manifest.websocket !== 'object' ||
      Array.isArray(manifest.websocket)
    ) {
      return 'invalid manifest shape: websocket must be an object';
    }
    const ws = manifest.websocket as Record<string, unknown>;
    if (!Array.isArray(ws.routes)) {
      return 'invalid manifest shape: websocket.routes must be an array';
    }
    for (const r of ws.routes) {
      if (r == null || typeof r !== 'object' || Array.isArray(r)) {
        return 'invalid manifest shape: websocket.routes entries must be objects';
      }
      const ro = r as Record<string, unknown>;
      if (typeof ro.className !== 'string') {
        return 'invalid manifest shape: websocket.routes entries must have a string className';
      }
      if (ro.bindingName !== undefined && typeof ro.bindingName !== 'string') {
        return 'invalid manifest shape: websocket.routes entry bindingName must be a string';
      }
    }
    if (!Array.isArray(ws.classes) || !ws.classes.every((x) => typeof x === 'string')) {
      return 'invalid manifest shape: websocket.classes must be an array of strings';
    }
    if (ws.migrations !== undefined) {
      if (!Array.isArray(ws.migrations)) {
        return 'invalid manifest shape: websocket.migrations must be an array';
      }
      for (const mg of ws.migrations) {
        if (mg == null || typeof mg !== 'object' || Array.isArray(mg)) {
          return 'invalid manifest shape: websocket.migrations entries must be objects';
        }
      }
    }
  }

  // TODO(0067): reject manifest.sandbox when the deploy type is static/spa
  // and there are no worker files. This is currently tolerated as a no-op
  // (the deploy provisions nothing) but a clearer signal at validation time
  // would prevent stale-manifest leakage.
  if (manifest.sandbox !== undefined) {
    if (
      manifest.sandbox == null ||
      typeof manifest.sandbox !== 'object' ||
      Array.isArray(manifest.sandbox)
    ) {
      return 'invalid manifest shape: sandbox must be an object';
    }
    const sandbox = manifest.sandbox as Record<string, unknown>;
    for (const key of ['bindingName', 'className', 'containerName', 'image']) {
      if (typeof sandbox[key] !== 'string' || sandbox[key].length === 0) {
        return `invalid manifest shape: sandbox.${key} must be a non-empty string`;
      }
    }
    if (isLocalImageReference(sandbox.image as string)) {
      return 'invalid manifest shape: sandbox.image must be a registry image reference';
    }
    if (sandbox.instanceType !== undefined && typeof sandbox.instanceType !== 'string') {
      return 'invalid manifest shape: sandbox.instanceType must be a string';
    }
    if (
      sandbox.maxInstances !== undefined &&
      (typeof sandbox.maxInstances !== 'number' ||
        !Number.isInteger(sandbox.maxInstances) ||
        sandbox.maxInstances < 1)
    ) {
      return 'invalid manifest shape: sandbox.maxInstances must be a positive integer';
    }
    if (sandbox.migrations !== undefined) {
      if (!Array.isArray(sandbox.migrations)) {
        return 'invalid manifest shape: sandbox.migrations must be an array';
      }
      for (const migration of sandbox.migrations) {
        if (migration == null || typeof migration !== 'object' || Array.isArray(migration)) {
          return 'invalid manifest shape: sandbox.migrations entries must be objects';
        }
        const mg = migration as Record<string, unknown>;
        if (typeof mg.tag !== 'string') {
          return 'invalid manifest shape: sandbox.migrations entries must have a string tag';
        }
        if (
          mg.newSqliteClasses !== undefined &&
          (!Array.isArray(mg.newSqliteClasses) ||
            !mg.newSqliteClasses.every((x) => typeof x === 'string'))
        ) {
          return 'invalid manifest shape: sandbox.migrations newSqliteClasses must be an array of strings';
        }
        if (
          mg.deletedClasses !== undefined &&
          (!Array.isArray(mg.deletedClasses) ||
            !mg.deletedClasses.every((x) => typeof x === 'string'))
        ) {
          return 'invalid manifest shape: sandbox.migrations deletedClasses must be an array of strings';
        }
      }
    }
  }

  if (manifest.live !== undefined) {
    if (
      manifest.live == null ||
      typeof manifest.live !== 'object' ||
      Array.isArray(manifest.live)
    ) {
      return 'invalid manifest shape: live must be an object';
    }
    const live = manifest.live as Record<string, unknown>;
    for (const key of ['bindingName', 'className']) {
      if (typeof live[key] !== 'string' || live[key].length === 0) {
        return `invalid manifest shape: live.${key} must be a non-empty string`;
      }
    }
    if (live.storage !== 'sqlite') {
      return 'invalid manifest shape: live.storage must be "sqlite"';
    }
    if (!Array.isArray(live.classes) || !live.classes.every((x) => typeof x === 'string')) {
      return 'invalid manifest shape: live.classes must be an array of strings';
    }
    if (live.migrations !== undefined) {
      if (!Array.isArray(live.migrations)) {
        return 'invalid manifest shape: live.migrations must be an array';
      }
      for (const migration of live.migrations) {
        if (migration == null || typeof migration !== 'object' || Array.isArray(migration)) {
          return 'invalid manifest shape: live.migrations entries must be objects';
        }
        const mg = migration as Record<string, unknown>;
        if (typeof mg.tag !== 'string') {
          return 'invalid manifest shape: live.migrations entries must have a string tag';
        }
        if (
          mg.newSqliteClasses !== undefined &&
          (!Array.isArray(mg.newSqliteClasses) ||
            !mg.newSqliteClasses.every((x) => typeof x === 'string'))
        ) {
          return 'invalid manifest shape: live.migrations newSqliteClasses must be an array of strings';
        }
      }
    }
  }

  return null;
}

function isLocalImageReference(image: string): boolean {
  const lowerImage = image.toLowerCase();
  return (
    image.startsWith('.') ||
    image.startsWith('/') ||
    lowerImage === 'dockerfile' ||
    lowerImage.includes('dockerfile') ||
    lowerImage.endsWith('/dockerfile') ||
    lowerImage.endsWith('\\dockerfile')
  );
}

function parseManifest(raw: string | null | undefined): DeployManifest | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
}

function parseAssetManifest(raw: string | null): Record<string, AssetManifestEntry> | null {
  if (raw === null || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as Record<string, AssetManifestEntry>;
  } catch {
    return null;
  }
}

function equalAssetManifests(
  a: Record<string, AssetManifestEntry> | null,
  b: Record<string, AssetManifestEntry> | null,
): boolean {
  if (!a || !b) {
    return false;
  }
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  for (const [path, entry] of aEntries) {
    const other = b[path];
    if (!other || other.hash !== entry.hash || other.size !== entry.size) {
      return false;
    }
  }
  return true;
}

async function buildComparableAssetManifestForDedupe(
  db: Db,
  projectId: string,
  built: Record<string, AssetManifestEntry>,
  declared: Record<string, AssetManifestEntry> | null,
  preflightRaw: string | null,
): Promise<Record<string, AssetManifestEntry> | null> {
  const result: Record<string, AssetManifestEntry> = declared ? { ...declared } : { ...built };

  for (const [path, entry] of Object.entries(built)) {
    const declaredEntry = declared?.[path];
    if (declared && !declaredEntry) {
      continue;
    }
    if (
      declaredEntry &&
      typeof declaredEntry.hash === 'string' &&
      declaredEntry.hash.length === 32 &&
      Number.isFinite(declaredEntry.size) &&
      declaredEntry.size >= 0
    ) {
      // The real deploy path must still surface this as an error event after
      // createDeployment; returning null here only disables the dedupe
      // short-circuit for an invalid request.
      if (declaredEntry.hash !== entry.hash) {
        return null;
      }
      if (declaredEntry.size === entry.size) {
        result[path] = declaredEntry;
      } else {
        result[path] = entry;
      }
    } else {
      result[path] = entry;
    }
  }

  if (preflightRaw === 'true' && !declared) {
    const fillManifest = await getLastLiveAssetManifest(db, projectId);
    if (fillManifest) {
      for (const [path, entry] of Object.entries(fillManifest)) {
        if (!(path in result)) {
          result[path] = entry;
        }
      }
    }
  }

  return result;
}

function sanitizeDeployErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (
    isCfAssetPlainText(trimmed) ||
    // JSON.parse SyntaxError truncates the original text (e.g. `Unexpected token 'A', "Assets hav"...`)
    // so the full substring won't match — detect the truncated form too
    /Unexpected token.*"Assets hav/.test(trimmed)
  ) {
    return 'asset upload returned an unexpected Cloudflare response';
  }
  return message;
}

async function assertDeploymentNotCanceled(db: Db, deploymentId: string): Promise<void> {
  const latest = await getDeployment(db, deploymentId);
  if (latest && CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status)) {
    throw new Error('deployment canceled');
  }
}

// Race guard against concurrent project teardown (design-doc 0067 §7).
// Teardown takes a project-row lock and flips `projects.status='deleting'`
// before tearing down CF state. A concurrent deploy that has already passed
// `assertDeploymentNotCanceled` could still race the route flip and recreate
// routing for a deleted project. Calling this alongside every cancellation
// check (and re-checking under FOR UPDATE at the final commit) closes that
// window. The atomic precheck-and-claim transaction below holds the same
// FOR UPDATE lock teardown uses, serializing the two flows.
const PROJECT_DELETING_ERROR_MESSAGE = 'project deletion in progress';

/**
 * Sentinel error thrown by the atomic precheck-and-claim transaction to
 * signal "another deploy is already in flight". The route handler catches
 * this and returns HTTP 409. Defined as a class (not a string sentinel) so
 * the catch-path can do an `instanceof` check without colliding with
 * arbitrary error messages from elsewhere in the transaction.
 */
class ConcurrentDeployError extends Error {
  constructor(public readonly deploymentId: string) {
    super(`deploy in progress: ${deploymentId}`);
    this.name = 'ConcurrentDeployError';
  }
}

async function assertProjectNotDeleting(db: Db, projectId: string): Promise<void> {
  const project = await getProject(db, projectId);
  // Fail closed: a missing project row is treated the same as `status='deleting'`.
  // After teardown flips status='deleting' and `deleteProjectCascade` removes the
  // project row, an in-flight deploy that observes the missing row would otherwise
  // sail past this guard and recreate routing/worker state for an already-deleted
  // project. Throwing here funnels both cases into the same catch-path branch
  // (PROJECT_DELETING_ERROR_MESSAGE) which rolls back KV writes and the worker.
  if (!project || project.status === 'deleting') {
    throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
  }
}

export function buildWebSocketUploadMigrations(
  migrations: Array<WebSocketMigrationMeta> | undefined,
):
  | {
      new_tag: string;
      steps: Array<{
        new_classes?: Array<string>;
        deleted_classes?: Array<string>;
      }>;
    }
  | undefined {
  return buildLegacyWebSocketUploadMigrations(migrations);
}

export function buildDurableObjectUploadMigrations(
  websocketMigrations: Array<WebSocketMigrationMeta> | undefined,
  sandboxMigrations: Array<SandboxMigrationMeta> | undefined,
  liveMigrations: Array<LiveMigrationMeta> | undefined = undefined,
):
  | {
      new_tag: string;
      steps: Array<{
        new_classes?: Array<string>;
        new_sqlite_classes?: Array<string>;
        deleted_classes?: Array<string>;
      }>;
    }
  | undefined {
  const steps: Array<{
    tag: string;
    index: number;
    new_classes?: Array<string>;
    new_sqlite_classes?: Array<string>;
    deleted_classes?: Array<string>;
  }> = [];

  for (const migration of websocketMigrations ?? []) {
    steps.push({
      tag: migration.tag,
      index: steps.length,
      ...(migration.newClasses?.length ? { new_classes: migration.newClasses } : {}),
      ...(migration.deletedClasses?.length ? { deleted_classes: migration.deletedClasses } : {}),
    });
  }

  for (const migration of sandboxMigrations ?? []) {
    steps.push({
      tag: migration.tag,
      index: steps.length,
      ...(migration.newSqliteClasses?.length
        ? { new_sqlite_classes: migration.newSqliteClasses }
        : {}),
      ...(migration.deletedClasses?.length ? { deleted_classes: migration.deletedClasses } : {}),
    });
  }

  for (const migration of liveMigrations ?? []) {
    steps.push({
      tag: migration.tag,
      index: steps.length,
      ...(migration.newSqliteClasses?.length
        ? { new_sqlite_classes: migration.newSqliteClasses }
        : {}),
    });
  }

  if (steps.length === 0) {
    return undefined;
  }

  const sortedSteps = [...steps].sort(compareDurableObjectMigrationSteps);

  return {
    new_tag: sortedSteps[sortedSteps.length - 1].tag,
    steps: sortedSteps.map(({ tag: _tag, index: _index, ...step }) => step),
  };
}

function compareDurableObjectMigrationSteps(
  a: { tag: string; index: number },
  b: { tag: string; index: number },
): number {
  const aVersion = parseMigrationTagVersion(a.tag);
  const bVersion = parseMigrationTagVersion(b.tag);
  if (aVersion !== null && bVersion !== null && aVersion !== bVersion) {
    return aVersion - bVersion;
  }
  return a.index - b.index;
}

function parseMigrationTagVersion(tag: string): number | null {
  const match = /-v(\d+)$/.exec(tag);
  return match ? Number(match[1]) : null;
}

export function buildLegacyWebSocketUploadMigrations(
  migrations: Array<WebSocketMigrationMeta> | undefined,
):
  | {
      new_tag: string;
      steps: Array<{
        new_classes?: Array<string>;
        deleted_classes?: Array<string>;
      }>;
    }
  | undefined {
  if (!migrations || migrations.length === 0) {
    return undefined;
  }

  return {
    new_tag: migrations[migrations.length - 1].tag,
    steps: migrations.map((migration) =>
      migration.newClasses?.length ? { new_classes: migration.newClasses } : {},
    ),
  };
}

export function buildWebSocketUploadBindings(
  websocket: DeployManifest['websocket'] | undefined,
): Array<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!websocket) {
    return [];
  }

  const bindings = new Map<string, string>();

  for (const route of websocket.routes) {
    const bindingName = route.bindingName ?? route.className;
    bindings.set(bindingName, route.className);
  }

  const boundClasses = new Set(bindings.values());
  for (const className of sortUnique(websocket.classes)) {
    if (!boundClasses.has(className)) {
      bindings.set(className, className);
    }
  }

  return Array.from(bindings, ([name, class_name]) => ({
    type: 'durable_object_namespace',
    name,
    class_name,
  }));
}

/**
 * Per-deploy user worker owns its own Sandbox class. CF rejects cross-script
 * DO bindings into dispatch namespaces (the resolver only sees account-level
 * scripts), so each deploy declares its own DO namespace + container app.
 */
export function buildSandboxUploadBindings(sandbox: DeployManifest['sandbox'] | undefined): Array<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!sandbox) {
    return [];
  }
  return [
    {
      type: 'durable_object_namespace',
      name: sandbox.bindingName,
      class_name: sandbox.className,
    },
  ];
}

export function buildLiveUploadBindings(live: DeployManifest['live'] | undefined): Array<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!live) {
    return [];
  }
  return [
    {
      type: 'durable_object_namespace',
      name: live.bindingName,
      class_name: live.className,
    },
  ];
}

export function buildSandboxUploadContainers(
  sandbox: DeployManifest['sandbox'] | undefined,
): Array<{ class_name: string }> | undefined {
  return sandbox ? [{ class_name: sandbox.className }] : undefined;
}

export function enrichWebSocketManifest(
  manifest: DeployManifest,
  previousManifest: DeployManifest | null,
  currentVersion: number,
): { manifest: DeployManifest; changed: boolean; nextVersion: number } {
  const nextClasses = sortUnique(manifest.websocket?.classes);
  const previousClasses = sortUnique(previousManifest?.websocket?.classes);
  const previousMigrations = previousManifest?.websocket?.migrations ?? [];
  const changed = !sameClassSet(nextClasses, previousClasses);

  if (!changed) {
    if (!manifest.websocket && previousMigrations.length === 0) {
      return { manifest, changed: false, nextVersion: currentVersion };
    }
    return {
      manifest: {
        ...manifest,
        websocket: manifest.websocket
          ? {
              ...manifest.websocket,
              classes: nextClasses,
              migrations: previousMigrations,
            }
          : previousManifest?.websocket,
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  // Compute classes that currently exist in Cloudflare by replaying
  // migration history: add from newClasses, remove from deletedClasses.
  // Also include previousClasses as fallback for legacy projects that
  // predate the migration system.
  const existingClasses = new Set(previousClasses);
  for (const m of previousMigrations) {
    for (const name of m.newClasses ?? []) {
      existingClasses.add(name);
    }
    for (const name of m.deletedClasses ?? []) {
      existingClasses.delete(name);
    }
  }
  const newClasses = nextClasses.filter((name) => !existingClasses.has(name));

  // If no new classes to create, no migration step is needed.
  // The class list update is still recorded in the manifest.
  if (newClasses.length === 0) {
    return {
      manifest: {
        ...manifest,
        websocket: {
          routes: manifest.websocket?.routes ?? [],
          classes: nextClasses,
          migrations: previousMigrations,
        },
      },
      changed: true,
      nextVersion: currentVersion,
    };
  }

  const nextVersion = currentVersion + 1;
  const migration: WebSocketMigrationMeta = {
    tag: `ws-v${nextVersion}`,
    newClasses,
  };

  return {
    manifest: {
      ...manifest,
      websocket: {
        routes: manifest.websocket?.routes ?? [],
        classes: nextClasses,
        migrations: [...previousMigrations, migration],
      },
    },
    changed: true,
    nextVersion,
  };
}

export function enrichSandboxManifest(
  manifest: DeployManifest,
  previousManifest: DeployManifest | null,
  currentVersion: number,
): { manifest: DeployManifest; changed: boolean; nextVersion: number } {
  if (!manifest.sandbox) {
    return { manifest, changed: false, nextVersion: currentVersion };
  }

  const previousSandbox = previousManifest?.sandbox;
  const previousMigrations = previousSandbox?.migrations ?? [];
  const nextClass = manifest.sandbox.className;
  const previousClass = previousSandbox?.className;

  if (nextClass === previousClass && previousMigrations.length > 0) {
    return {
      manifest: {
        ...manifest,
        sandbox: {
          ...manifest.sandbox,
          migrations: previousMigrations,
        },
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  const existingClasses = new Set<string>();
  if (previousClass) {
    existingClasses.add(previousClass);
  }
  for (const migration of previousMigrations) {
    for (const className of migration.newSqliteClasses ?? []) {
      existingClasses.add(className);
    }
    for (const className of migration.deletedClasses ?? []) {
      existingClasses.delete(className);
    }
  }

  if (existingClasses.has(nextClass)) {
    return {
      manifest: {
        ...manifest,
        sandbox: {
          ...manifest.sandbox,
          migrations: previousMigrations,
        },
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  const nextVersion = currentVersion + 1;
  const migration: SandboxMigrationMeta = {
    tag: `sandbox-v${nextVersion}`,
    newSqliteClasses: [nextClass],
  };

  return {
    manifest: {
      ...manifest,
      sandbox: {
        ...manifest.sandbox,
        migrations: [...previousMigrations, migration],
      },
    },
    changed: true,
    nextVersion,
  };
}

export function enrichLiveManifest(
  manifest: DeployManifest,
  previousManifest: DeployManifest | null,
  currentVersion: number,
): { manifest: DeployManifest; changed: boolean; nextVersion: number } {
  if (!manifest.live) {
    return { manifest, changed: false, nextVersion: currentVersion };
  }

  const previousLive = previousManifest?.live;
  const previousMigrations = previousLive?.migrations ?? [];
  const nextClasses = sortUnique(manifest.live.classes);
  const nextClass = manifest.live.className;

  if (previousLive?.className === nextClass && previousMigrations.length > 0) {
    return {
      manifest: {
        ...manifest,
        live: {
          ...manifest.live,
          classes: nextClasses,
          migrations: previousMigrations,
        },
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  const existingClasses = new Set<string>();
  if (previousLive?.className) {
    existingClasses.add(previousLive.className);
  }
  for (const className of previousLive?.classes ?? []) {
    existingClasses.add(className);
  }
  for (const migration of previousMigrations) {
    for (const className of migration.newSqliteClasses ?? []) {
      existingClasses.add(className);
    }
  }

  if (existingClasses.has(nextClass)) {
    return {
      manifest: {
        ...manifest,
        live: {
          ...manifest.live,
          classes: nextClasses,
          migrations: previousMigrations,
        },
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  const nextVersion = currentVersion + 1;
  const migration: LiveMigrationMeta = {
    tag: `live-v${nextVersion}`,
    newSqliteClasses: [nextClass],
  };

  return {
    manifest: {
      ...manifest,
      live: {
        ...manifest.live,
        classes: nextClasses,
        migrations: [...previousMigrations, migration],
      },
    },
    changed: true,
    nextVersion,
  };
}

// Cap on the number of presign requests in a single batch. Presigning is
// CPU-light (one HMAC chain per call) but unbounded fanout still costs
// memory and lets a malformed CLI burn server CPU without bound. 5000
// matches the largest realistic dist/ asset count we've observed (memora
// repro: 570; design doc 0068's TBD ceiling). Asset manifests on the
// JSON-mode deploy share the same cap for symmetry.
const MAX_UPLOAD_URLS_BATCH = 5000;
// Body cap for `POST /:id/deploy/upload-urls`. The body is dominated by
// `assets[]` entries — each entry is ~150 bytes (blake3 + md5 + size +
// contentType). 5000 entries × ~150 bytes ≈ 750 KB, so 4 MiB carries a
// 4× safety margin. Asset BYTES never travel this endpoint — they go
// direct-to-R2 via the presigned PUTs this endpoint issues.
const MAX_UPLOAD_URLS_BODY_BYTES = 4 * 1024 * 1024;
// Bounded concurrency for the presign batch. Presigning is CPU-light;
// 50 in-flight is generous and keeps tail latency bounded without
// fanning out to 5000 simultaneous async tasks.
const PRESIGN_BATCH_CONCURRENCY = 50;
// Bounded concurrency for the R2 head check that verifies declared assets
// were actually uploaded by the CLI before the JSON-mode deploy proceeds.
// 20 matches R2's typical head-throughput sweet spot — verifying 5000
// assets at this concurrency completes in well under the deploy heartbeat
// interval.
const R2_HEAD_VERIFY_CONCURRENCY = 20;
// Per-blake3 / per-md5 validation: 32 lowercase hex characters.
const HEX_32_REGEX = /^[0-9a-f]{32}$/;
// Generous body cap for JSON-mode deploy POSTs. The body is dominated by
// `workerFiles` (base64-encoded user worker modules); MAX_WORKER_FILE_BYTES
// is 32 MiB per module and a worker can ship ~10 modules in practice.
//
// Base64 expansion is ~33%, so a single 32 MiB raw module weighs ~43 MiB
// on the wire. 64 MiB comfortably accommodates one full-size module (with
// safety margin) plus the manifest, assetManifest, vars, and source/commit
// JSON, while staying well under the 128 MiB Worker memory limit. Asset
// BYTES are NOT in this body — they go direct-to-R2 via presigned PUTs,
// which is the whole reason this endpoint exists.
const MAX_JSON_DEPLOY_BODY_BYTES = 64 * 1024 * 1024;

interface UploadUrlsRequestAsset {
  blake3: string;
  md5: string;
  size: number;
  contentType: string;
}

/**
 * Validate a single `assets[]` entry from `POST /:id/deploy/upload-urls`.
 * Returns an error message on failure, `null` on success. Mirrors the
 * presigner's MD5 validation so a malformed input is rejected at the
 * platform boundary rather than inside `presignAssetPut`.
 */
function validateUploadUrlsAsset(asset: unknown, index: number): string | null {
  if (asset == null || typeof asset !== 'object' || Array.isArray(asset)) {
    return `invalid assets[${index}]: must be an object`;
  }
  const a = asset as Record<string, unknown>;
  if (typeof a.blake3 !== 'string' || !HEX_32_REGEX.test(a.blake3)) {
    return `invalid assets[${index}].blake3: must be 32 lowercase hex characters`;
  }
  if (typeof a.md5 !== 'string' || !HEX_32_REGEX.test(a.md5)) {
    return `invalid assets[${index}].md5: must be 32 lowercase hex characters`;
  }
  if (
    typeof a.size !== 'number' ||
    !Number.isInteger(a.size) ||
    a.size < 0 ||
    !Number.isFinite(a.size)
  ) {
    return `invalid assets[${index}].size: must be a non-negative integer`;
  }
  if (typeof a.contentType !== 'string' || a.contentType.length === 0) {
    return `invalid assets[${index}].contentType: must be a non-empty string`;
  }
  return null;
}

/**
 * Issue presigned R2 PUT URLs for a batch of declared assets.
 *
 * Auth and ownership are handled the same way as `/deploy/preflight`:
 * project loaded, `user_id` checked, 403 on mismatch, 404 on missing.
 * Each asset's blake3 keys it under `assets/${projectId}/${blake3}`; MD5
 * is signed into the URL's headers so R2 enforces "uploaded bytes' MD5
 * matches declared MD5" at write time. URLs expire in 30 minutes.
 *
 * Returns `{ urls: { [blake3]: { url, headers } } }`. Note: when two
 * assets in the batch share a blake3 (deduplicated content under
 * different paths), the second write to the result map wins — both are
 * pointed at the same key, so this is the intended dedupe behaviour.
 *
 * FOLLOW-UP: For very slow deploys (large bundles + low bandwidth + low
 * upload concurrency), a 30-min TTL can still expire on the tail of the
 * upload pool before that asset's PUT runs. The next iteration of this
 * endpoint should re-presign on `SignatureExpired` 403 from R2 — keyed
 * off a CLI-side retry against `/deploy/upload-urls` for the affected
 * blake3s. Tracking issue: see meta/design-docs/0068 follow-up.
 */
// Sentinel thrown out of the upload-urls FOR-SHARE transaction to signal
// "project flipped to status='deleting' before we acquired the lock".
// Caught at the awaiting site to surface a 410 to the CLI. Mirrors the
// `PROJECT_DELETING_ERROR_MESSAGE` pattern used by `handleManifestOnlyDeploy`.
const UPLOAD_URLS_PROJECT_DELETING = 'upload_urls:project_deleting';

app.post('/:id/deploy/upload-urls', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }
  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // Fast 410 — mirror `handleManifestOnlyDeploy`. The unlocked read here
  // is a TOCTOU best-effort: it short-circuits the common case (project
  // already marked `deleting` before this request arrived). The
  // authoritative status check happens inside the FOR-SHARE transaction
  // below so a teardown that lands AFTER this read but BEFORE we issue
  // presigns is forced to wait until our share lock releases — and any
  // teardown that already committed before we acquired the lock will be
  // observed by the in-tx re-read and surface as a 410.
  if (project.status === 'deleting') {
    return c.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs BEFORE body parsing so a stale CLI sending a
  // multipart body gets the friendly 426 upgrade message instead of an
  // opaque "invalid JSON body" 400 from the JSON parse below. Runs AFTER
  // the unlocked 410 fast-path so a stale CLI hitting an already-deleting
  // project still sees the more specific 410 ("upgrading won't bring the
  // project back"). The remaining 426-vs-410 race window — where the
  // status flips to `deleting` between the unlocked check and this gate
  // — is microseconds (no I/O between them) and surfaces as 426 to the
  // CLI; that's a UX wart, not a correctness bug, since the user does
  // need to upgrade anyway.
  const versionReject = checkCliVersionOrRespond(c);
  if (versionReject) {
    return versionReject;
  }
  // TODO(orphan-gc): authenticated users can upload bytes via upload-urls
  // without ever finalizing a deploy, leaving durable orphans. Teardown
  // cleans these up; for active projects, abandoned uploads accumulate
  // until a future deploy's retention cleanup happens to walk over them.
  // Track in a follow-up: add a periodic per-project R2 sweep that diffs
  // `assets/${projectId}/*` against the union of retained manifests.

  const startedAt = Date.now();
  const logger = createDeployLogger({
    projectId,
    projectSlug: project.slug,
    userId: c.get('user').id,
    branch: null,
  });

  // Stream the body with a hard size cap before JSON.parse — `c.req.json()`
  // would otherwise buffer arbitrary bytes from a malicious / buggy client
  // before parsing, peaking at body bytes plus a UTF-16 string plus the
  // parsed object. The cap is enforced via TransformStream so we abort the
  // moment the threshold is crossed; native `Response.json()` then handles
  // streaming + parsing efficiently. Mirrors `handleManifestOnlyDeploy`.
  if (!c.req.raw.body) {
    return c.json({ error: 'request body is required' }, 400);
  }
  let totalBytes = 0;
  let overflowed = false;
  const limited = c.req.raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_UPLOAD_URLS_BODY_BYTES) {
          overflowed = true;
          controller.error(new Error('body too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  let parsed: unknown;
  try {
    parsed = await new Response(limited, {
      headers: { 'Content-Type': 'application/json' },
    }).json();
  } catch (err) {
    if (overflowed) {
      return c.json(
        {
          error: `request body exceeds ${MAX_UPLOAD_URLS_BODY_BYTES} bytes`,
        },
        413,
      );
    }
    return c.json(
      { error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return c.json({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsed as Record<string, unknown>;
  if (!Array.isArray(body.assets)) {
    return c.json({ error: 'request body must include an `assets` array' }, 400);
  }
  if (body.assets.length > MAX_UPLOAD_URLS_BATCH) {
    return c.json(
      {
        error: `assets[] has ${body.assets.length} entries, exceeds the ${MAX_UPLOAD_URLS_BATCH} per-request limit`,
      },
      400,
    );
  }
  for (let i = 0; i < body.assets.length; i++) {
    const err = validateUploadUrlsAsset(body.assets[i], i);
    if (err) {
      return c.json({ error: err }, 400);
    }
  }
  const assets = body.assets as Array<UploadUrlsRequestAsset>;

  logger.info('upload_urls', 'request', { assetCount: assets.length });

  const urls: Record<string, { url: string; headers: Record<string, string> }> = {};
  try {
    // Serialize against project teardown. `lockAndMarkDeleting` takes
    // FOR UPDATE on the project row in `provisioning/cleanup.ts`; we take
    // FOR SHARE here, which is compatible with concurrent upload-urls /
    // deploy precheck calls (also FOR SHARE / FOR UPDATE on the same row,
    // queueing as Postgres allows) but blocks teardown until this
    // transaction commits. Once the lock is acquired we re-read the
    // project row inside the transaction; if status flipped to `deleting`
    // between the unlocked early-out above and the lock acquisition,
    // throw the sentinel to surface a 410 to the CLI.
    //
    // Lock window: presigning is pure HMAC (no R2 / DB / network I/O
    // beyond the initial SELECT FOR SHARE). A 5000-entry batch fans out
    // to 50 concurrent crypto.subtle signs and finishes in ~250 ms, so
    // teardown never waits long for the share lock to release.
    await c.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR SHARE`);
      const txDb = tx as unknown as Db;
      const lockedProject = await getProject(txDb, projectId);
      if (!lockedProject || lockedProject.status === 'deleting') {
        throw new Error(UPLOAD_URLS_PROJECT_DELETING);
      }
      await uploadPool(assets, PRESIGN_BATCH_CONCURRENCY, async (asset) => {
        const result = await presignAssetPut({
          accountId: c.env.CF_ACCOUNT_ID,
          accessKeyId: c.env.R2_ACCESS_KEY_ID,
          secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
          bucket: c.env.R2_STATIC_ASSETS_BUCKET,
          key: `assets/${projectId}/${asset.blake3}`,
          md5: asset.md5,
          contentType: asset.contentType,
          // 30 minutes. With ~570 assets, concurrency=10, and a slow uplink
          // a tail asset can sit in the pool for >10 min before its first
          // PUT — 600s expired and R2 returned 403 SignatureExpired which
          // the CLI treats as terminal. 1800s covers all realistic
          // deploys; pathological multi-hour deploys are deferred to the
          // re-presign-on-expiry follow-up noted in the docstring above.
          ttlSeconds: 1800,
        });
        // Last-write-wins on duplicate blake3 — see docstring above. Map
        // assignment is synchronous so concurrent pool tasks do not race
        // beyond a benign last-writer.
        urls[asset.blake3] = result;
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === UPLOAD_URLS_PROJECT_DELETING) {
      return c.json({ error: 'project is being deleted' }, 410);
    }
    logger.error('upload_urls', 'presign_error', err, { assetCount: assets.length });
    return c.json(
      {
        error: `failed to presign upload URLs: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  logger.info('upload_urls', 'response', {
    urlsIssued: Object.keys(urls).length,
    durationMs: Date.now() - startedAt,
  });

  return c.json({ urls });
});

// Deploy to a project
app.post('/:id/deploy', handleManifestOnlyDeploy);

/**
 * JSON-mode (manifest-only) deploy handler — direct-to-R2 asset upload flow.
 *
 * Operates on a JSON request body. The CLI uploads asset bytes directly
 * to R2 via presigned PUTs (issued by the `/deploy/upload-urls` endpoint
 * above) BEFORE calling this handler, so the request body carries only:
 *   - `manifest` (DeployManifest, must declare `assetManifestVersion: 2`)
 *   - `assetManifest` (path → { blake3, md5, size })
 *   - `source`, `commit`, `repositoryUrl`, `commitUrl`, `gitRef`, `preflight`
 *   - `vars` (optional plain-text bindings — same as `manifest.vars`)
 *   - `workerFiles` (base64-encoded module bytes for WfP deploys; absent for
 *     static-only deploys)
 *
 * The bytes for declared assets MUST already be in `STATIC_ASSETS_R2` under
 * `assets/${projectId}/${blake3}` — the handler does parallel `R2.head` to
 * verify before the deploy proceeds. A missing hash is a hard 400.
 *
 * For static deploys, every asset's serving-manifest entry is `!{hash}` —
 * direct-to-R2 always lands in R2. For WfP deploys, asset bytes are fetched
 * back from `STATIC_ASSETS_R2` to populate the in-memory `assetsByHash` map
 * that `uploadAssetBuckets` consumes — server-internal R2-to-CF traffic
 * bypasses the user's request pipe, which is the whole point of the
 * direct-to-R2 flow.
 */
async function handleManifestOnlyDeploy(c: Context<ApiEnv>): Promise<Response> {
  // Hono's `c.req.param('id')` types as `string | undefined` when called
  // from a non-route-typed context (we receive `Context<ApiEnv>` rather
  // than the route-typed callback Hono synthesises for `app.post`). The
  // route literal is `/:id/deploy`, so this is always a string at
  // runtime — narrow by hand. The ApiEnv route registry guarantees the
  // path matched.
  const projectId = c.req.param('id') as string;
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }
  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (project.status === 'deleting') {
    return c.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs AFTER project authz so a stale CLI hitting a
  // missing/foreign/deleting project still gets the more specific
  // 404/403/410 first. The multipart sniff inside the helper is
  // header-only — it does not read the request body, so calling it
  // here does not interfere with the streaming JSON parse below.
  const versionReject = checkCliVersionOrRespond(c);
  if (versionReject) {
    return versionReject;
  }

  const user = c.get('user');

  let logger: DeployLogger = createDeployLogger({
    projectId,
    projectSlug: project.slug,
    userId: user.id,
    branch: null,
  });

  // Parse + validate the JSON body BEFORE the precheck-and-claim transaction.
  // A malformed body should not consume the project's active-deploy slot —
  // the JSON body can be validated up-front and rejected without ever
  // inserting a placeholder row.
  //
  // Stream the body through a counting TransformStream and let
  // `Response.json()` handle the parse natively. The previous implementation
  // collected chunks into an Array, copied them into a Uint8Array, decoded
  // to a UTF-16 string, and ran JSON.parse — peaking at ~4× the body size
  // in residency for a body that can legitimately reach 64 MiB. Native
  // Response.json() consumes the stream incrementally and reuses internal
  // buffers; the only retained allocation at the end is the parsed object.
  if (!c.req.raw.body) {
    return c.json({ error: 'request body is required' }, 400);
  }
  let totalBytes = 0;
  let overflowed = false;
  const limited = c.req.raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_JSON_DEPLOY_BODY_BYTES) {
          overflowed = true;
          controller.error(new Error('body too large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  let parsedBody: unknown;
  try {
    parsedBody = await new Response(limited, {
      headers: { 'Content-Type': 'application/json' },
    }).json();
  } catch (err) {
    if (overflowed) {
      return c.json(
        {
          error: `request body exceeds ${MAX_JSON_DEPLOY_BODY_BYTES} bytes (asset bytes must be uploaded direct-to-R2, not in the request body)`,
        },
        413,
      );
    }
    return c.json(
      { error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }
  if (parsedBody == null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return c.json({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsedBody as Record<string, unknown>;

  // Manifest validation. `validateManifestShape` is the canonical source of
  // truth for what's accepted; the `assetManifestVersion === 2` check below
  // requires the v2 wire shape (blake3 + md5 + size per asset) that
  // direct-to-R2 deploys depend on.
  if (body.manifest == null || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) {
    return c.json({ event: 'error', message: 'manifest is required and must be an object' }, 400);
  }
  const shapeError = validateManifestShape(body.manifest);
  if (shapeError) {
    return c.json({ event: 'error', message: shapeError }, 400);
  }
  const incomingManifest = body.manifest as DeployManifest;
  if (
    incomingManifest.version == null ||
    !SUPPORTED_MANIFEST_VERSIONS.includes(incomingManifest.version)
  ) {
    return c.json(
      { event: 'error', message: 'Unsupported deploy manifest version. Please update void.' },
      400,
    );
  }
  if (incomingManifest.assetManifestVersion !== 2) {
    return c.json(
      {
        event: 'error',
        message: 'deploy requires assetManifestVersion: 2; please upgrade your void CLI',
      },
      400,
    );
  }

  // Validate the v2 asset manifest. Each entry MUST carry a 32-hex blake3
  // (storage key), 32-hex md5 (R2 PUT integrity check), and a non-negative
  // integer size. We translate the v2 entries into the v1 shape
  // (`{ hash: blake3, size }`) the rest of the pipeline expects — this
  // keeps the existing dedupe / retention / serving-manifest code paths
  // unchanged. The md5 isn't carried into the persisted manifest because
  // BLAKE3 is the storage-key identifier and md5 is purely a write-time
  // R2 integrity primitive.
  if (
    body.assetManifest == null ||
    typeof body.assetManifest !== 'object' ||
    Array.isArray(body.assetManifest)
  ) {
    return c.json(
      { event: 'error', message: 'assetManifest is required and must be an object' },
      400,
    );
  }
  const rawAssetManifest = body.assetManifest as Record<string, unknown>;
  const assetEntries = Object.entries(rawAssetManifest);
  if (assetEntries.length > MAX_UPLOAD_URLS_BATCH) {
    return c.json(
      {
        event: 'error',
        message: `assetManifest has ${assetEntries.length} entries, exceeds the ${MAX_UPLOAD_URLS_BATCH} per-deploy limit`,
      },
      400,
    );
  }
  const incomingAssetManifest: Record<string, AssetManifestEntry> = {};
  for (const [path, raw] of assetEntries) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json(
        { event: 'error', message: `invalid assetManifest entry for ${path}: must be an object` },
        400,
      );
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.blake3 !== 'string' || !HEX_32_REGEX.test(entry.blake3)) {
      return c.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: blake3 must be 32 lowercase hex characters`,
        },
        400,
      );
    }
    if (typeof entry.md5 !== 'string' || !HEX_32_REGEX.test(entry.md5)) {
      return c.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: md5 must be 32 lowercase hex characters`,
        },
        400,
      );
    }
    if (
      typeof entry.size !== 'number' ||
      !Number.isInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isFinite(entry.size)
    ) {
      return c.json(
        {
          event: 'error',
          message: `invalid assetManifest entry for ${path}: size must be a non-negative integer`,
        },
        400,
      );
    }
    incomingAssetManifest[path] = { hash: entry.blake3, size: entry.size };
  }

  // Optional metadata fields.
  const source = typeof body.source === 'string' ? body.source : null;
  const commit = typeof body.commit === 'string' ? body.commit : null;
  const repositoryUrl = typeof body.repositoryUrl === 'string' ? body.repositoryUrl : null;
  const commitUrl = typeof body.commitUrl === 'string' ? body.commitUrl : null;
  const gitRef = typeof body.gitRef === 'string' ? body.gitRef : null;
  const preflightRaw = body.preflight === 'true' ? 'true' : null;

  // workerFiles is the only meaningful body content beyond the manifest
  // tuples. Each entry is a base64-encoded module body keyed by relative
  // path with a per-module cap of MAX_WORKER_FILE_BYTES (32 MiB). Absent or
  // empty means a static-only deploy.
  const workerFiles: Array<{ name: string; content: Blob }> = [];
  if (body.workerFiles !== undefined) {
    if (
      body.workerFiles == null ||
      typeof body.workerFiles !== 'object' ||
      Array.isArray(body.workerFiles)
    ) {
      return c.json(
        { event: 'error', message: 'workerFiles must be an object mapping relative path → base64' },
        400,
      );
    }
    // Decode each base64 module to bytes and drop the source string from the
    // parsed body before moving to the next entry. The previous implementation
    // walked `for…of Object.entries(...)` over a captured snapshot, holding
    // the entire `workerFiles` map (and thus every base64 string) live for
    // the full loop. For a near-cap module that source string alone is ~43
    // MiB UTF-16 (≈86 MiB), and the explicit `atob` + per-byte loop added a
    // second 64 MiB latin1 string before the `Uint8Array` allocation —
    // enough peak residency to push the isolate past 128 MiB on a single
    // 32 MiB module. Iterating through `body.workerFiles` directly and
    // `delete`-ing each property after decode lets V8 reclaim the source
    // string before peak. We also prefer the (now-stage-4) `fromBase64`
    // helper — single-allocation, no intermediate string — falling back to
    // the previous loop for runtimes that don't expose it (e.g. Node-based
    // tests; the production CF Workers compat date is 2026-02-12 and ships
    // the helper natively).
    const workerFilesMap = body.workerFiles as Record<string, unknown>;
    for (const filePath of Object.keys(workerFilesMap)) {
      const raw = workerFilesMap[filePath];
      if (typeof raw !== 'string') {
        return c.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} must be a base64-encoded string`,
          },
          400,
        );
      }
      let decoded: Uint8Array;
      try {
        decoded = decodeBase64ToBytes(raw);
      } catch (err) {
        return c.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
          },
          400,
        );
      }
      // Release the source string back to GC now that the bytes are
      // materialized — see the block comment above.
      delete workerFilesMap[filePath];
      if (decoded.byteLength > MAX_WORKER_FILE_BYTES) {
        return c.json(
          {
            event: 'error',
            message: `workerFiles entry for ${filePath} exceeds ${MAX_WORKER_FILE_BYTES} bytes`,
          },
          413,
        );
      }
      // Hand the bytes directly to a `Blob` so we never name the
      // `Uint8Array` past this scope — keeps per-iteration memory residency
      // bounded by one decoded module at a time.
      workerFiles.push({
        name: filePath,
        content: new Blob([decoded as unknown as BlobPart], {
          type: moduleContentType(filePath),
        }),
      });
    }
  }
  const hasWorkerFiles = workerFiles.length > 0;

  // Reject worker files for static manifest types. Without this check a
  // malformed CLI could send `workerFiles` for a `'spa'` / `'static'`
  // manifest and end up deploying a WfP worker, breaking the project type
  // invariants. Done BEFORE placeholder insert so a rejected request
  // doesn't leave a phantom row to reap.
  if (hasWorkerFiles && (incomingManifest.type === 'spa' || incomingManifest.type === 'static')) {
    return c.json(
      {
        event: 'error',
        message: 'worker parts are not allowed when manifest.type is spa or static',
      },
      400,
    );
  }

  // (env vars travel inside `manifest.vars`; the JSON-mode wire contract
  // never accepted a top-level `body.vars` — every CLI version that ever
  // hit this endpoint populated `manifest.vars` instead.)

  // Pre-validation done — now run the atomic precheck-and-claim
  // transaction. FOR UPDATE on the project row, 10-minute stale-deploy
  // reaper, placeholder insert. Once the placeholder row exists, every
  // later failure must route through the catch / finally below to avoid
  // leaving it stranded in `pending`.
  const currentLiveDeployment = project.active_deployment_id
    ? await getDeployment(c.get('db'), project.active_deployment_id)
    : null;

  let preDeployment: Awaited<ReturnType<typeof createDeployment>>;
  try {
    preDeployment = await c.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const txDb = tx as unknown as Db;
      const lockedProject = await getProject(txDb, projectId);
      if (!lockedProject || lockedProject.status === 'deleting') {
        throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
      }
      const activeDeploy = await getActiveDeployment(txDb, projectId);
      if (activeDeploy) {
        const createdAt = activeDeploy.created_at.includes('T')
          ? activeDeploy.created_at
          : activeDeploy.created_at.replace(' ', 'T') + 'Z';
        const ageMs = Date.now() - new Date(createdAt).getTime();
        if (ageMs < 10 * 60 * 1000) {
          throw new ConcurrentDeployError(activeDeploy.id);
        }
        const staleNext = activeDeploy.status === 'canceling' ? 'canceled' : 'failed';
        logger.info('status_transition', 'status_change', {
          deploymentId: activeDeploy.id,
          from: activeDeploy.status,
          to: staleNext,
          reason: 'precheck_reap_timeout',
        });
        await updateDeploymentStatus(
          txDb,
          activeDeploy.id,
          staleNext,
          'timed out',
          activeDeploy.status === 'canceling' ? { force: true } : undefined,
        );
      }
      return await createDeployment(txDb, projectId, null, null, null);
    });
  } catch (err) {
    if (err instanceof ConcurrentDeployError) {
      return c.json({ error: 'deploy in progress', deployment: err.deploymentId }, 409);
    }
    if (err instanceof Error && err.message === PROJECT_DELETING_ERROR_MESSAGE) {
      return c.json({ error: 'project is being deleted' }, 410);
    }
    throw err;
  }

  const planLimits = getPlanLimits(user.plan);

  // Construct the response stream — same NDJSON wire contract as the
  // multipart path (heartbeats, progress events, `done`/`error`).
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let streamOpen = true;
  let currentStep = 'parsing';
  let currentDeploymentId: string = preDeployment.id;
  let currentStatus: DeploymentStatus = 'pending';
  let phaseName = 'parsing';
  let phaseStartMs = Date.now();
  const markPhase = (next: string): void => {
    const now = Date.now();
    logger.info(phaseName, 'phase_end', { durationMs: now - phaseStartMs });
    phaseName = next;
    phaseStartMs = now;
    logger.info(next, 'phase_start');
  };
  const emit = (event: DeployEvent): void => {
    logger.info('emit', 'ndjson_event', event as unknown as Record<string, unknown>);
    if (!streamOpen) {
      return;
    }
    writer.write(encoder.encode(JSON.stringify(event) + '\n')).catch((err) => {
      streamOpen = false;
      logger.warn('emit', 'stream_closed', { event: event.event, err: String(err) });
    });
  };
  const heartbeatOverride = c.env.DEPLOY_HEARTBEAT_INTERVAL_MS;
  const heartbeatIntervalMs =
    typeof heartbeatOverride === 'number' &&
    Number.isFinite(heartbeatOverride) &&
    heartbeatOverride > 0
      ? Math.max(1, heartbeatOverride)
      : 15_000;

  void (async () => {
    logger.info('json_validate', 'phase_start');
    phaseName = 'json_validate';
    phaseStartMs = Date.now();
    let routingSwitched = false;
    const writtenRoutingKeys: Array<string> = [];
    let workerUploaded = false;
    let workerUploadUrl: string | undefined;
    let sandboxContainerAppId: string | undefined;
    let sandboxContainerAppName: string | undefined;
    let bundleStored = false;
    let manifest: DeployManifest | undefined;
    let workerName: string | undefined;
    let dispatchNamespace: string | undefined;
    let deployment: Awaited<ReturnType<typeof createDeployment>> | undefined;
    let projectDomains: Awaited<ReturnType<typeof getDomainsByProjectId>> | undefined;

    // Bytes uploaded directly to R2 by the CLI before this request landed.
    // For static deploys this map stays empty (the static branch reads
    // them straight from R2 by hash). For WfP deploys it gets populated
    // from R2 fetches further down — the CF asset upload session needs
    // the actual bytes to fan into upload buckets.
    const assetsByHash = new Map<string, AssetEntry>();
    // For JSON mode, every asset lives in R2 (direct-to-R2 uploads never
    // touch KV). We still pass `streamedHashStores` / `streamedLargeHashes`
    // / `streamedStaticAssets=true` into the static branch so it builds
    // the serving manifest correctly with `!` prefixes on every entry.
    // The map stays empty for cleanup-on-abort: the bytes pre-existed
    // this deploy and may be needed for a retry, so we never delete them
    // on a JSON-mode failure.
    const streamedHashStores = new Map<string, 'kv' | 'r2'>();
    const streamedLargeHashes = new Set<string>();

    const heartbeat = setInterval(() => {
      emit(
        currentDeploymentId
          ? { event: 'heartbeat', deploymentId: currentDeploymentId, step: currentStep }
          : { event: 'heartbeat', step: currentStep },
      );
    }, heartbeatIntervalMs);

    let wfpMirroredManifestDeploymentId: string | null = null;

    try {
      // === ASSET VERIFY (R2 head) ===
      // Verify every NEW declared asset exists in R2 before claiming a
      // deployment slot's worth of pipeline work. This is the JSON-mode
      // analogue of the multipart path's "the bytes arrived in the body"
      // invariant — without it, a buggy CLI that skipped an upload
      // would deploy a serving manifest that 404s for the missing path.
      //
      // Carry-forward: hashes present in the prior live deployment's
      // `asset_hashes` are preflight-skipped and already exist somewhere
      // (KV OR R2) for the prior deploy. Skip R2.head() for those because
      // (a) the CLI was never asked to upload them this deploy, and (b)
      // the prior placement may be KV (small assets), in which case R2
      // would correctly return null. We only verify hashes that are NEW
      // to this deploy — those MUST exist in R2 because the CLI was
      // supposed to direct-upload them via a presigned URL.
      currentStep = 'asset_verify';
      markPhase('asset_verify');
      const priorAssetManifest = await getLastLiveAssetManifest(c.get('db'), projectId);
      const carryForwardHashes = new Set<string>();
      if (priorAssetManifest) {
        for (const entry of Object.values(priorAssetManifest)) {
          carryForwardHashes.add(entry.hash);
        }
      }
      const declaredHashes = Array.from(
        new Set(Object.values(incomingAssetManifest).map((e) => e.hash)),
      );
      const newHashes = declaredHashes.filter((h) => !carryForwardHashes.has(h));
      const missingHashes: Array<string> = [];
      const missingMutex: { busy: boolean } = { busy: false };
      const r2HeadCache = new Map<string, { size: number } | null>();
      await uploadPool(newHashes, R2_HEAD_VERIFY_CONCURRENCY, async (hash) => {
        const key = `assets/${projectId}/${hash}`;
        const head = await c.env.STATIC_ASSETS_R2.head(key);
        // Single-writer atomicity: this `set` is synchronous so concurrent
        // pool tasks don't actually race the map even though they share
        // it. Cache it so the WfP path below can reuse the head metadata
        // (for the size-based KV-vs-R2 split, though direct-to-R2 lands
        // everything in R2 — see below).
        r2HeadCache.set(hash, head ? { size: head.size } : null);
        if (!head) {
          // Single-writer atomicity is enough here: array `push` is
          // synchronous and each iteration either pushes once or doesn't.
          // The mutex guard is a hint to keep the cap-truncation logic
          // race-free if it grows.
          if (!missingMutex.busy) {
            missingMutex.busy = true;
            missingHashes.push(hash);
            missingMutex.busy = false;
          } else {
            missingHashes.push(hash);
          }
        }
      });
      if (missingHashes.length > 0) {
        const cap = 10;
        const sample = missingHashes.slice(0, cap);
        const more = missingHashes.length > cap ? ` (+${missingHashes.length - cap} more)` : '';
        emit({
          event: 'error',
          message:
            `${missingHashes.length} declared asset hash${missingHashes.length === 1 ? '' : 'es'} not found in R2: ${sample.join(', ')}${more}. ` +
            `Upload may have been skipped, or presigned URLs may have expired (10 min TTL). Re-run preflight + upload-urls.`,
          step: currentStep,
        });
        return;
      }

      // === MANIFEST VALIDATION & DEDUPE ===
      currentStep = 'validating';
      markPhase('manifest_validate');

      const previousManifest = parseManifest(currentLiveDeployment?.manifest);
      const websocketManifestResult = enrichWebSocketManifest(
        incomingManifest,
        previousManifest,
        project.websocket_version,
      );
      const enrichedManifestResult = enrichSandboxManifest(
        websocketManifestResult.manifest,
        previousManifest,
        websocketManifestResult.nextVersion,
      );
      const liveManifestResult = enrichLiveManifest(
        enrichedManifestResult.manifest,
        previousManifest,
        enrichedManifestResult.nextVersion,
      );
      const manifestVersionChanged =
        websocketManifestResult.changed ||
        enrichedManifestResult.changed ||
        liveManifestResult.changed;
      manifest = liveManifestResult.manifest;
      const finalManifestRaw = JSON.stringify(manifest);

      // Host-scoped routing rules — same logic as multipart path.
      const hostScopedRedirects = manifest.redirectRules?.some((r) => r.host) ?? false;
      const hostScopedFallbacks = manifest.fallbackRules?.some((r) => r.host) ?? false;
      if (hostScopedRedirects || hostScopedFallbacks) {
        const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
        projectDomains ??= await getDomainsByProjectId(c.get('db'), projectId);
        const boundHosts = new Set<string>([`${project.slug}.${siteDomain}`]);
        for (const d of projectDomains) {
          boundHosts.add(d.hostname);
        }
        const unbound = [...(manifest.redirectRules ?? []), ...(manifest.fallbackRules ?? [])]
          .map((r) => r.host)
          .filter((h): h is string => typeof h === 'string' && !boundHosts.has(h));
        if (unbound.length > 0) {
          const unique = Array.from(new Set(unbound));
          emit({
            event: 'error',
            message: `routing rule host not bound to project: ${unique.join(', ')} — add the domain (\`void domain add\`) before deploying rules scoped to it`,
            step: currentStep,
          });
          return;
        }
      }

      // Dedupe-skip. JSON-mode CLIs always send the full assetManifest
      // (including preflight-skipped paths), so `built` and `declared`
      // collapse to the same object — the dedupe helper just normalises
      // the comparison shape and returns it.
      const builtAssetManifest = incomingAssetManifest;
      const comparableAssetManifest = await buildComparableAssetManifestForDedupe(
        c.get('db'),
        projectId,
        builtAssetManifest,
        incomingAssetManifest,
        preflightRaw,
      );

      if (!hasWorkerFiles && currentLiveDeployment && currentLiveDeployment.status === 'live') {
        const sameManifest = currentLiveDeployment.manifest === finalManifestRaw;
        const sameAssets = equalAssetManifests(
          comparableAssetManifest,
          parseAssetManifest(currentLiveDeployment.asset_hashes),
        );
        if (sameManifest && sameAssets) {
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          projectDomains ??= await getDomainsByProjectId(c.get('db'), projectId);
          const activeDomains = projectDomains.filter((d) => d.status === 'active');
          const fullUrl =
            activeDomains.length > 0
              ? `https://${activeDomains[0].hostname}`
              : `https://${project.slug}.${siteDomain}`;

          emit({ event: 'start', deploymentId: currentLiveDeployment.id });
          emit({
            event: 'done',
            deployment: currentLiveDeployment.id,
            url: fullUrl,
            urls: [
              ...activeDomains.map((d) => `https://${d.hostname}`),
              `https://${project.slug}.${siteDomain}`,
            ],
            assets: 0,
            workers: 0,
          });
          // Release the placeholder row — verified no-op.
          await c.get('db').delete(deployments).where(eq(deployments.id, preDeployment.id));
          return;
        }
      }

      // Daily deploy-count limit. JSON-mode deploys don't write any KV/R2
      // bytes during this request (assets pre-existed direct-to-R2), so
      // we can defer the cap check until AFTER the dedupe short-circuit
      // — same as the multipart path's worker-backed branch.
      if (planLimits.deploysPerDay > 0) {
        const todayCount = await countUserDeploymentsToday(c.get('db'), c.get('user').id);
        if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
          emit({ event: 'error', message: 'deploy limit exceeded', step: currentStep });
          return;
        }
      }

      // Fill in the deployment record (same FOR UPDATE pattern as
      // multipart). Once this completes the deployment row is no longer
      // a precheck placeholder — every subsequent failure must transition
      // it to a terminal status via the catch path.
      deployment = await c.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const txDb = tx as unknown as Db;
        const lockedProject = await getProject(txDb, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
        }
        return await updateDeploymentManifest(
          txDb,
          preDeployment.id,
          finalManifestRaw,
          source,
          commit,
          {
            repositoryUrl,
            commitUrl,
            gitRef,
          },
        );
      });
      currentDeploymentId = deployment.id;
      logger = logger.with({ deploymentId: deployment.id });
      if (manifestVersionChanged) {
        await updateProjectWebSocketVersion(c.get('db'), projectId, liveManifestResult.nextVersion);
      }
      dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      workerName = `user-${project.slug}-${deployment.id}`;

      const pipelineDeployment = deployment;
      const pipelineManifest = manifest;
      const pipelineWorkerName = workerName;
      const pipelineDispatchNamespace = dispatchNamespace;

      try {
        const deployment = pipelineDeployment;
        const manifest = pipelineManifest;
        const workerName = pipelineWorkerName;
        const dispatchNamespace = pipelineDispatchNamespace;

        emit({ event: 'start', deploymentId: deployment.id });

        // === ASSET UPLOAD PHASE ===
        currentStep = 'asset_upload';
        markPhase('asset_upload');
        logger.info('status_transition', 'status_change', {
          from: currentStatus,
          to: 'uploading',
        });
        await updateDeploymentStatus(c.get('db'), deployment.id, 'uploading');
        currentStatus = 'uploading';
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);

        // JSON-mode CLI always sends the full assetManifest including
        // preflight-skipped paths; no server-side fill-in needed. Clone so
        // the cache-buster injection below mutates a fresh object rather
        // than the validated incoming map.
        const assetManifest: Record<string, AssetManifestEntry> = { ...incomingAssetManifest };
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);

        const preflightUsed = preflightRaw === 'true';
        const isStaticOnly = !hasWorkerFiles;
        logger = logger.with({ branch: isStaticOnly ? 'static' : 'wfp' });

        // CF dedupe-poisoning workaround: same as multipart path. WfP
        // deploys with non-empty asset manifests inject a unique cache
        // buster so CF's asset session always sees at least one novel
        // hash. The buster's bytes still need to reach CF, so we put
        // them directly into `assetsByHash` (not into our R2 — they're
        // a deploy-local artifact, not a CLI-uploaded asset).
        if (!isStaticOnly && Object.keys(assetManifest).length > 0) {
          const bustPath = `/.void-deploy/${deployment.id}.txt`;
          const bustContent = `${deployment.id}\n${Date.now()}\n`;
          const bustBytes = new TextEncoder().encode(bustContent);
          const bustBuffer = bustBytes.buffer.slice(
            bustBytes.byteOffset,
            bustBytes.byteOffset + bustBytes.byteLength,
          );
          const bustHash = computeAssetHash(bustBuffer, bustPath);
          assetManifest[bustPath] = { hash: bustHash, size: bustBytes.byteLength };
          assetsByHash.set(bustHash, {
            bytes: bustBytes,
            contentType: 'text/plain; charset=utf-8',
          });
        }

        const assetCount = Object.keys(assetManifest).length;

        projectDomains ??= await getDomainsByProjectId(c.get('db'), projectId);

        if (isStaticOnly) {
          // Static-only branch: bytes already in R2; build the serving
          // manifest with `!{hash}` for every entry (direct-to-R2 always
          // lands in R2). No KV/R2 writes for asset bodies — only the
          // serving manifest under `manifest:{deploymentId}` and the
          // routing entry under `project.slug`.
          currentStep = 'asset_upload';
          const assetConfig = manifest.assetConfig ?? {
            not_found_handling: 'single-page-application',
          };

          // We didn't upload anything new this request — every asset was
          // pre-uploaded direct-to-R2 by the CLI. `new` and `cached`
          // here represent "verified existing in R2" and convey the
          // same information shape as the multipart path's
          // `streamedStaticAssets` branch.
          emit({
            event: 'asset_upload',
            total: assetCount,
            new: 0,
            cached: assetCount,
          });
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          await assertProjectNotDeleting(c.get('db'), projectId);
          emit({ event: 'asset_upload_done' });

          // Build serving manifest. Carry-forward hashes (declared in the
          // prior live deploy's `asset_hashes`) MUST preserve the prior
          // KV-vs-R2 placement: small assets in the prior deploy live in
          // KV (no `!` prefix), and rewriting them as `!hash` would point
          // dispatch's WfP fallback at R2 keys that don't exist. New
          // hashes (not in the prior manifest) were just uploaded
          // direct-to-R2 by the CLI and always use the `!` prefix.
          //
          // We always read the prior serving manifest (not just when
          // `preflightUsed` is true) — a CLI that re-declares the same
          // hashes without preflight still relies on carry-forward to
          // serve those bytes from their existing KV/R2 home.
          let prevServingManifest: Record<string, string> | null = null;
          if (project.active_deployment_id) {
            const prev = await c.env.ROUTING.get(`manifest:${project.active_deployment_id}`);
            if (prev) {
              prevServingManifest = JSON.parse(prev) as Record<string, string>;
            }
          }
          const prevHashEntry = new Map<string, string>();
          if (prevServingManifest) {
            for (const v of Object.values(prevServingManifest)) {
              const hash = v.startsWith('!') ? v.slice(1) : v;
              prevHashEntry.set(hash, v);
            }
          }

          const servingManifest: Record<string, string> = {};
          for (const [path, entry] of Object.entries(assetManifest)) {
            if (carryForwardHashes.has(entry.hash) && prevHashEntry.has(entry.hash)) {
              // Carry-forward — preserve prior placement (KV vs R2).
              servingManifest[path] = prevHashEntry.get(entry.hash)!;
            } else if (carryForwardHashes.has(entry.hash)) {
              // Carry-forward by hash (existed in prior `asset_hashes`)
              // but the prior serving manifest is gone (e.g. dedupe
              // GC'd the entry). Direct-to-R2 lands carry-forward bytes
              // nowhere new this deploy, so we have no `!` guarantee —
              // omit and rely on the dispatch fallback chain. Same gap
              // case as the multipart path's else branch.
            } else {
              // New this deploy — verified in R2 above; direct-to-R2
              // always uses the `!` prefix.
              servingManifest[path] = `!${entry.hash}`;
            }
          }

          await c.env.ROUTING.put(`manifest:${deployment.id}`, JSON.stringify(servingManifest));

          await c
            .get('db')
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));

          const type =
            manifest.type ??
            (assetConfig.not_found_handling === 'single-page-application' ? 'spa' : 'static');

          const existingRouting = await c.env.ROUTING.get(project.slug);
          const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
          const routingJson = buildStaticRoutingJson({
            projectId,
            userId: project.user_id,
            deploymentId: deployment.id,
            assetConfig,
            manifest,
            suspended: existingEntry?.suspended,
          });
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          await assertProjectNotDeleting(c.get('db'), projectId);
          markPhase('routing_switch');
          await c.env.ROUTING.put(project.slug, routingJson);
          writtenRoutingKeys.push(project.slug);
          routingSwitched = true;
          logger = logger.with({ routingSwitched: true });
          logger.info('routing_switch', 'slug_routed', { slug: project.slug });

          for (const domain of projectDomains) {
            if (domain.status === 'active') {
              const domainKey = `domain:${domain.hostname}`;
              await c.env.ROUTING.put(domainKey, routingJson);
              writtenRoutingKeys.push(domainKey);
            }
          }

          markPhase('db_finalize');
          logger.info('status_transition', 'status_change', {
            from: currentStatus,
            to: 'live',
            reason: 'static_deploy',
          });
          await c.get('db').transaction(async (tx) => {
            await tx.execute(
              drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
            );
            const txDb = tx as unknown as Db;
            const lockedProject = await getProject(txDb, projectId);
            if (!lockedProject || lockedProject.status === 'deleting') {
              throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
            }
            await updateDeploymentStatus(txDb, deployment.id, 'live', undefined, {
              force: true,
            });
            await updateProjectType(txDb, projectId, type);
          });
          currentStatus = 'live';
          await setActiveDeployment(c.get('db'), projectId, deployment.id);
          await markDeploymentRetained(c.get('db'), deployment.id, true);

          await clearCronScheduler(c.env, projectId);

          const legacyName = `user-${project.slug}`;
          await deleteDispatchScript(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            dispatchNamespace,
            legacyName,
          );

          const retained = await getRetainedDeploymentsExcluding(
            c.get('db'),
            projectId,
            deployment.id,
          );
          for (const old of retained) {
            await deleteDispatchScript(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              dispatchNamespace,
              `user-${project.slug}-${old.id}`,
            );
          }

          markPhase('retention_cleanup');
          if (STATIC_RETENTION_LIMIT > 0) {
            const toEvict = retained.slice(STATIC_RETENTION_LIMIT - 1);
            // Build the post-eviction retained-hashes union once. Always
            // built (independent of `toEvict.length`) because the R2
            // keyspace sweep below uses it to opportunistically GC
            // direct-to-R2 orphans (bytes uploaded via presigned PUTs that
            // never finalized into a live deploy).
            const retainedHashes = new Set<string>();
            for (const [, entry] of Object.entries(assetManifest)) {
              retainedHashes.add(entry.hash);
            }
            const keptDeployments = retained.slice(0, STATIC_RETENTION_LIMIT - 1);
            for (const kept of keptDeployments) {
              if (kept.asset_hashes) {
                try {
                  const keptManifest = JSON.parse(kept.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  for (const entry of Object.values(keptManifest)) {
                    retainedHashes.add(entry.hash);
                  }
                } catch (e) {
                  logger.warn('retention_cleanup', 'retained_asset_hashes_parse_failed', {
                    retainedDeploymentId: kept.id,
                    err: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            }

            for (const old of toEvict) {
              if (old.asset_hashes) {
                const evictedManifest = JSON.parse(old.asset_hashes) as Record<
                  string,
                  { hash: string }
                >;
                const evictedHashes = Object.values(evictedManifest).map((e) => e.hash);
                await deleteUnreferencedAssets(
                  c.env.STATIC_ASSETS,
                  c.env.STATIC_ASSETS_R2,
                  evictedHashes,
                  retainedHashes,
                  projectId,
                );
              }
              await c.env.ROUTING.delete(`manifest:${old.id}`);
              await markDeploymentRetained(c.get('db'), old.id, false);
            }

            // Direct-to-R2 orphan sweep. See WfP branch for rationale —
            // orphans uploaded via presigned PUTs that never finalized are
            // not named in any manifest, so the eviction loop misses them.
            // Best-effort: a failed sweep should not fail the deploy.
            try {
              const orphans = await sweepProjectAssetOrphans(
                c.env.STATIC_ASSETS_R2,
                projectId,
                retainedHashes,
              );
              if (orphans > 0) {
                logger.info('retention_cleanup', 'r2_orphans_swept', { count: orphans });
              }
            } catch (e) {
              logger.warn('retention_cleanup', 'r2_orphan_sweep_failed', {
                err: e instanceof Error ? e.message : String(e),
              });
            }
          }

          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          const activeDomains = projectDomains.filter((d) => d.status === 'active');
          const url =
            activeDomains.length > 0
              ? `https://${activeDomains[0].hostname}`
              : `https://${project.slug}.${siteDomain}`;

          emit({
            event: 'done',
            deployment: deployment.id,
            url,
            urls: [
              ...activeDomains.map((d) => `https://${d.hostname}`),
              `https://${project.slug}.${siteDomain}`,
            ],
            assets: assetCount,
            workers: 0,
          });
          return;
        }

        // === WfP branch ===
        // Direct-to-R2 doesn't change anything about CF's asset upload
        // session: CF still wants the actual bytes to fan into upload
        // buckets. We fetch the bytes back from OUR R2 (where the CLI
        // just uploaded them) — server-internal R2-to-CF traffic that
        // doesn't go through the user's pipe. The fetch concurrency
        // matches the existing R2 head verify pool.
        currentStep = 'provisioning';
        markPhase('provisioning');

        const bindingLabels: Array<string> = [];
        for (const name of manifest.bindings.d1 ?? []) {
          bindingLabels.push(`d1:${name}`);
        }
        for (const name of manifest.bindings.kv ?? []) {
          bindingLabels.push(`kv:${name}`);
        }
        for (const name of manifest.bindings.r2 ?? []) {
          bindingLabels.push(`r2:${name}`);
        }
        for (const q of manifest.queues ?? []) {
          bindingLabels.push(`queue:${q.name}`);
        }
        if (bindingLabels.length > 0) {
          emit({ event: 'provisioning', bindings: bindingLabels });
        }

        const workerBindings = await provisionBindings(
          c.get('db'),
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          projectId,
          manifest,
          c.env.JWT_SECRET,
          c.env.VOID_PROXY_SERVICE ?? 'void-proxy',
        );
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);

        if (bindingLabels.length > 0) {
          emit({ event: 'provisioning_done' });
        }

        if (typeof manifest.vars?.[BETTER_AUTH_SECRET_NAME] === 'string') {
          throw new Error(
            `${BETTER_AUTH_SECRET_NAME} must be configured via project secrets, not manifest.vars`,
          );
        }

        let projectSecretRows = await getProjectSecrets(c.get('db'), projectId);
        if (manifest.auth) {
          const existingAuthSecret = projectSecretRows.find(
            (row) => row.name === BETTER_AUTH_SECRET_NAME,
          );
          if (!existingAuthSecret) {
            const managedSecret = generateManagedAuthSecret();
            const encrypted = await encryptProjectSecret(
              c.env,
              projectId,
              BETTER_AUTH_SECRET_NAME,
              managedSecret,
            );
            await upsertProjectSecret(
              c.get('db'),
              projectId,
              BETTER_AUTH_SECRET_NAME,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.keyVersion,
              'auth-default',
            );
            projectSecretRows = await getProjectSecrets(c.get('db'), projectId);
          }
        }
        const secretBindings = await Promise.all(
          projectSecretRows.map(async (row) => ({
            type: 'secret_text' as const,
            name: row.name,
            text: await decryptProjectSecret(c.env, projectId, row),
          })),
        );

        let completionJwt: string | undefined;
        if (assetCount > 0) {
          currentStep = 'asset_upload';
          markPhase('asset_upload');
          // Hydrate `assetsByHash` from R2. The cache-buster injected
          // above is already in `assetsByHash`; only fetch the rest.
          // Bounded concurrency matches the head-verify pool.
          const wfpDeclaredHashSet = new Set(
            Object.values(incomingAssetManifest).map((e) => e.hash),
          );
          const hashesNeedingBytes = Array.from(wfpDeclaredHashSet).filter(
            (h) => !assetsByHash.has(h),
          );
          await uploadPool(hashesNeedingBytes, R2_HEAD_VERIFY_CONCURRENCY, async (hash) => {
            const obj = await c.env.STATIC_ASSETS_R2.get(`assets/${projectId}/${hash}`);
            if (!obj) {
              // Should be impossible — we already head-verified above.
              // Surface as a hard error: a missing object after head
              // succeeded means R2 lost the bytes between head and get.
              throw new Error(
                `R2 object ${`assets/${projectId}/${hash}`} disappeared between head and get`,
              );
            }
            const ab = await obj.arrayBuffer();
            // Find a path in the asset manifest with this hash so we
            // can derive the content type for the CF asset upload.
            // Multiple paths can share a hash; any one is correct.
            let path = '';
            for (const [p, e] of Object.entries(incomingAssetManifest)) {
              if (e.hash === hash) {
                path = p;
                break;
              }
            }
            assetsByHash.set(hash, {
              bytes: new Uint8Array(ab),
              contentType: getContentType(path),
            });
          });
          // `new` reflects "newly uploaded by the CLI this deploy" —
          // for direct-to-R2 we don't re-upload, so we report 0 new
          // (every byte was pre-uploaded). The CF asset upload session
          // still dedupes against its own server-side index, which is
          // what the WfP path's `cached` semantic refers to.
          const newAssets = 0;
          emit({
            event: 'asset_upload',
            total: assetCount,
            new: newAssets,
            cached: assetCount - newAssets,
          });

          const session = await createAssetUploadSession(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            dispatchNamespace,
            workerName,
            // Strip extras (e.g. v2 `blake3`/`md5`) at the CF API boundary —
            // CF documents only `{ hash, size }` and may strictly validate.
            normalizeForCfAssetSession(assetManifest),
          );
          logger.info('asset_upload', 'session_created', {
            manifestEntries: Object.keys(assetManifest).length,
            buckets: session.buckets.length,
            blobsAvailable: assetsByHash.size,
          });

          completionJwt = await uploadAssetBuckets(
            c.env.CF_ACCOUNT_ID,
            session.jwt,
            session.buckets,
            assetsByHash,
          );
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          await assertProjectNotDeleting(c.get('db'), projectId);
          logger.info('asset_upload', 'upload_complete', {
            hasCompletionJwt: completionJwt !== undefined,
          });
          emit({ event: 'asset_upload_done' });

          await c
            .get('db')
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));

          // Mirror serving manifest. Direct-to-R2 already lands assets
          // in our R2; we just need to write the per-deploy serving
          // manifest so dispatch's WfP fallback can read them when CF's
          // asset store returns the dedupe-poisoning stub.
          const declaredHashes2 = new Set(Object.values(incomingAssetManifest).map((e) => e.hash));
          let prevServingManifest: Record<string, string> | null = null;
          if (preflightUsed && project.active_deployment_id) {
            const prev = await c.env.ROUTING.get(`manifest:${project.active_deployment_id}`);
            if (prev) {
              prevServingManifest = JSON.parse(prev) as Record<string, string>;
            }
          }
          const prevHashEntry = new Map<string, string>();
          if (prevServingManifest) {
            for (const v of Object.values(prevServingManifest)) {
              const hash = v.startsWith('!') ? v.slice(1) : v;
              prevHashEntry.set(hash, v);
            }
          }
          const servingManifest: Record<string, string> = {};
          for (const [path, entry] of Object.entries(assetManifest)) {
            if (declaredHashes2.has(entry.hash)) {
              // Direct-to-R2 always uses R2-prefixed entries.
              servingManifest[path] = `!${entry.hash}`;
            } else if (prevHashEntry.has(entry.hash)) {
              servingManifest[path] = prevHashEntry.get(entry.hash)!;
            }
            // else: preflight-skipped with no prior mirror — same gap
            // case as multipart; serving manifest omits.
          }
          await c.env.ROUTING.put(`manifest:${deployment.id}`, JSON.stringify(servingManifest));
          wfpMirroredManifestDeploymentId = deployment.id;
        }

        // 1. Worker upload
        currentStep = 'worker_upload';
        markPhase('worker_upload');
        const workerFormData = new FormData();
        emit({ event: 'worker_upload', modules: workerFiles.length });

        const RESERVED_BINDING_NAMES = new Set([
          '__VOID_PROXY',
          '__PROJECT_ID',
          '__VOID_PROXY_TOKEN',
          'ASSETS',
        ]);
        const userVarNames = Object.keys(manifest.vars ?? {});
        const reserved = userVarNames.filter((n) => RESERVED_BINDING_NAMES.has(n));
        if (reserved.length > 0) {
          throw new Error(`reserved binding names: ${reserved.join(', ')}`);
        }
        const secretNames = new Set(secretBindings.map((s) => s.name));
        const collisions = userVarNames.filter((n) => secretNames.has(n));
        if (collisions.length > 0) {
          logger.warn('worker_upload', 'var_secret_collisions', { collisions });
        }
        const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
          type: 'plain_text' as const,
          name,
          text,
        }));
        const websocketBindings = buildWebSocketUploadBindings(manifest.websocket);
        const sandboxBindings = buildSandboxUploadBindings(manifest.sandbox);
        const liveBindings = buildLiveUploadBindings(manifest.live);
        const allBindings = [
          ...plainTextBindings,
          ...secretBindings,
          ...workerBindings,
          ...websocketBindings,
          ...sandboxBindings,
          ...liveBindings,
          ...(completionJwt ? [{ name: 'ASSETS', type: 'assets' }] : []),
        ];

        if (!manifest.compatibilityDate) {
          logger.warn('worker_upload', 'missing_compatibility_date');
        }
        const assetConfig = manifest.assetConfig ?? { not_found_handling: 'none' };
        const durableObjectMigrations = buildDurableObjectUploadMigrations(
          manifest.websocket?.migrations,
          manifest.sandbox?.migrations,
          manifest.live?.migrations,
        );
        const containers = buildSandboxUploadContainers(manifest.sandbox);
        const tailServiceName = c.env.TAIL_SERVICE_NAME ?? DEFAULT_TAIL_SERVICE_NAME;
        const metadata: Record<string, unknown> = {
          main_module: manifest.workerMain ?? 'index.js',
          compatibility_date: manifest.compatibilityDate ?? '2026-02-12',
          compatibility_flags: manifest.compatibilityFlags ?? ['nodejs_compat'],
          bindings: allBindings,
          ...(durableObjectMigrations ? { migrations: durableObjectMigrations } : {}),
          ...(containers ? { containers } : {}),
          ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
          observability: {
            enabled: true,
            logs: { invocation_logs: true, head_sampling_rate: 1 },
          },
          tail_consumers: [{ service: tailServiceName }],
        };
        workerFormData.append(
          'metadata',
          new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
        );
        for (const file of workerFiles) {
          workerFormData.append(file.name, file.content, file.name);
        }

        workerUploadUrl = `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`;
        await retryWithBackoff(
          async (attempt) => {
            const attemptStart = Date.now();
            const cfResponse = await fetch(workerUploadUrl!, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` },
              body: workerFormData,
            });

            if (!cfResponse.ok) {
              const error = await cfResponse.text();
              logger.error('worker_upload', 'attempt_failed', new Error(error), {
                attempt,
                maxAttempts: CF_RETRY.maxRetries + 1,
                latencyMs: Date.now() - attemptStart,
                status: cfResponse.status,
                bodyPreview: error.slice(0, 500),
              });
              throw new Error(`worker upload failed: ${error}`);
            }

            const cfBody = await cfResponse.text();
            if (isCfAssetPlainText(cfBody)) {
              logger.warn('worker_upload', 'attempt_failed', {
                attempt,
                maxAttempts: CF_RETRY.maxRetries + 1,
                latencyMs: Date.now() - attemptStart,
                code: 'cf_plain_text',
                bodyPreview: cfBody.slice(0, 100),
              });
              return undefined;
            }
            return true;
          },
          {
            ...CF_RETRY,
            errorMessage: 'worker upload returned an unexpected Cloudflare response',
          },
        );
        workerUploaded = true;

        if (hasWorkerFiles) {
          try {
            await persistWorkerBundle(
              c.env.STATIC_ASSETS_R2,
              projectId,
              deployment.id,
              workerFiles,
            );
          } catch (err) {
            await deleteWorkerBundle(c.env.STATIC_ASSETS_R2, projectId, deployment.id).catch((e) =>
              logger.error('worker_upload', 'partial_bundle_cleanup_failed', e, {
                deploymentId: deployment!.id,
              }),
            );
            throw err;
          }
          await markDeploymentBundleStored(c.get('db'), deployment.id);
          bundleStored = true;
        }

        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);

        if (manifest.sandbox && hasWorkerFiles) {
          currentStep = 'sandbox_container';
          markPhase('sandbox_container');
          sandboxContainerAppName = perDeployContainerApplicationName(
            projectId,
            deployment.id,
            manifest.sandbox.containerName ?? 'void-sandbox',
          );
          const { containerApplicationId } = await provisionPerDeployContainer(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            dispatchNamespace,
            workerName,
            sandboxContainerAppName,
            manifest.sandbox.bindingName,
            manifest.sandbox.className,
            {
              image: manifest.sandbox.image,
              instanceType: manifest.sandbox.instanceType,
              maxInstances: manifest.sandbox.maxInstances,
            },
          );
          sandboxContainerAppId = containerApplicationId;
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          await assertProjectNotDeleting(c.get('db'), projectId);
        }

        emit({ event: 'worker_upload_done' });

        // Migrations
        let migrationsApplied = 0;
        if (manifest.migrations && manifest.migrations.pending > 0) {
          currentStep = 'migration';
          markPhase('migrate');
          logger.info('status_transition', 'status_change', {
            from: currentStatus,
            to: 'migrating',
          });
          await updateDeploymentStatus(c.get('db'), deployment.id, 'migrating');
          currentStatus = 'migrating';
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          await assertProjectNotDeleting(c.get('db'), projectId);
          emit({ event: 'migration_start', pending: manifest.migrations.pending });

          const proxyTokenBinding = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN');
          const probeResult = await retryWithBackoff<'ready' | 'compat'>(
            async (attempt) => {
              const attemptStart = Date.now();
              const maxAttempts = CF_READINESS_RETRY.maxRetries + 1;
              try {
                const userWorker = c.env.DISPATCH.get(workerName);
                const readyResponse = await userWorker.fetch(
                  new Request('https://internal/__void/ready', {
                    signal: AbortSignal.timeout(10_000),
                  }),
                );
                const text = await readyResponse.text();
                if (isCfAssetPlainText(text)) {
                  logger.warn('migrate', 'readiness_probe_attempt_failed', {
                    attempt,
                    maxAttempts,
                    latencyMs: Date.now() - attemptStart,
                    code: 'cf_plain_text',
                    bodyPreview: text.slice(0, 200),
                  });
                  return undefined;
                }
                try {
                  const data = JSON.parse(text);
                  if (data.ready === true) {
                    return 'ready';
                  }
                } catch {
                  // fall through
                }
                if (readyResponse.status === 404) {
                  return 'compat';
                }
                if (readyResponse.ok) {
                  logger.warn('migrate', 'readiness_probe_attempt_failed', {
                    attempt,
                    maxAttempts,
                    latencyMs: Date.now() - attemptStart,
                    code: 'non_json_2xx',
                    status: readyResponse.status,
                    bodyPreview: text.slice(0, 200),
                  });
                  return undefined;
                }
                logger.warn('migrate', 'readiness_probe_attempt_failed', {
                  attempt,
                  maxAttempts,
                  latencyMs: Date.now() - attemptStart,
                  status: readyResponse.status,
                });
                return undefined;
              } catch (err) {
                logger.warn('migrate', 'readiness_probe_attempt_failed', {
                  attempt,
                  maxAttempts,
                  latencyMs: Date.now() - attemptStart,
                  code: 'threw',
                  err: err instanceof Error ? err.message : String(err),
                });
                return undefined;
              }
            },
            {
              ...CF_READINESS_RETRY,
              errorMessage: 'worker readiness probe failed: new worker not reachable after retries',
            },
          );

          const migrationRetry = probeResult === 'ready' ? CF_MIGRATION_RETRY : CF_READINESS_RETRY;

          const result = await retryWithBackoff<UserWorkerMigrationResult>(
            async (attempt) => {
              const attemptStart = Date.now();
              const maxAttempts = migrationRetry.maxRetries + 1;
              const userWorker = c.env.DISPATCH.get(workerName);
              const migrateResponse = await userWorker.fetch(
                new Request('https://internal/__void/migrate', {
                  method: 'POST',
                  headers: { 'x-void-internal': proxyTokenBinding?.text ?? '' },
                  signal: AbortSignal.timeout(300_000),
                }),
              );

              const text = await migrateResponse.text();
              if (isCfAssetPlainText(text)) {
                logger.warn('migrate', 'attempt_failed', {
                  attempt,
                  maxAttempts,
                  latencyMs: Date.now() - attemptStart,
                  code: 'cf_plain_text',
                  bodyPreview: text.slice(0, 200),
                });
                return undefined;
              }

              try {
                return JSON.parse(text) as UserWorkerMigrationResult;
              } catch {
                if (migrateResponse.ok) {
                  logger.warn('migrate', 'attempt_failed', {
                    attempt,
                    maxAttempts,
                    latencyMs: Date.now() - attemptStart,
                    code: 'non_json_2xx',
                    status: migrateResponse.status,
                    bodyPreview: text.slice(0, 500),
                  });
                  return undefined;
                }
                throw new Error(
                  `migration failed (${migrateResponse.status}): ${text.slice(0, 200)}`,
                );
              }
            },
            {
              ...migrationRetry,
              errorMessage: 'migration dispatch failed after retries',
            },
          );

          if (!result.ok) {
            throw new Error(`migration failed: ${formatMigrationFailure(result)}`);
          }
          for (const m of result.migrations) {
            if (m.applied) {
              emit({ event: 'migration', name: m.name, durationMs: m.durationMs });
              migrationsApplied++;
            }
          }
          const allApplied = result.migrations.map((m) => m.name);
          await setAppliedMigrations(c.get('db'), deployment.id, allApplied);
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          await assertProjectNotDeleting(c.get('db'), projectId);
        }

        // Queue setup
        currentStep = 'queue_setup';
        markPhase('queue_setup');
        const queueNames = (manifest.queues ?? []).map((q) => q.name);
        if (queueNames.length > 0) {
          emit({ event: 'queue_setup', queues: queueNames });
        }
        const dispatchWorkerName = c.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
        const queueProxyToken = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text;
        const queueConflicts: Array<{ queue: string; ownerScript: string }> = [];
        const consumerOutcomes = await Promise.all(
          (manifest.queues ?? []).map(async (q) => {
            const queueBinding = workerBindings.find(
              (b) => b.type === 'queue' && b.name === q.bindingName,
            );
            if (!queueBinding?.queue_id) {
              return null;
            }
            const consumerResult = await addQueueConsumer(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              queueBinding.queue_id,
              dispatchWorkerName,
              {
                ...(q.maxBatchSize != null && { batch_size: q.maxBatchSize }),
                ...(q.maxBatchTimeout != null && {
                  max_wait_time_ms: q.maxBatchTimeout * 1000,
                }),
                ...(q.maxRetries != null && { max_retries: q.maxRetries }),
                ...(q.retryDelay != null && { retry_delay: q.retryDelay }),
              },
            );
            if (consumerResult.status === 'conflict') {
              emit({
                event: 'queue_consumer_conflict',
                queue: q.name,
                ownerScript: consumerResult.ownerScript,
              });
              queueConflicts.push({ queue: q.name, ownerScript: consumerResult.ownerScript });
            }
            return { q, queueBinding, status: consumerResult.status };
          }),
        );
        if (queueConflicts.length > 0) {
          const details = queueConflicts
            .map((conflict) => `${conflict.queue} owned by ${conflict.ownerScript}`)
            .join('; ');
          throw new Error(`queue consumer conflict: ${details}`);
        }
        for (const outcome of consumerOutcomes) {
          if (!outcome) {
            continue;
          }
          const queueKey = `queue:${outcome.queueBinding.queue_name}`;
          await c.env.ROUTING.put(
            queueKey,
            JSON.stringify({
              workerName,
              projectId,
              queueName: outcome.q.name,
              proxyToken: queueProxyToken,
            }),
          );
          writtenRoutingKeys.push(queueKey);
        }
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);

        const hasCrons = manifest.schedules && manifest.schedules.length > 0;

        await clearIsrCache(c.env.ISR_CACHE, projectId, deployment.id);
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);

        currentStep = 'prerender';
        if (manifest.prerender && manifest.prerender.length > 0 && manifest.revalidate) {
          markPhase('prerender');
          emit({ event: 'prerender', pages: manifest.prerender.length });
          logger.info('status_transition', 'status_change', {
            from: currentStatus,
            to: 'prerendering',
          });
          await updateDeploymentStatus(c.get('db'), deployment.id, 'prerendering');
          currentStatus = 'prerendering';
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          await assertProjectNotDeleting(c.get('db'), projectId);
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;

          await uploadPool(manifest.prerender, 3, async (pathname) => {
            const ttl = resolvePathTtl(manifest.revalidate, pathname);
            if (ttl <= 0) {
              return;
            }
            try {
              const userWorker = c.env.DISPATCH.get(workerName);
              const url = `https://${project.slug}.${siteDomain}${pathname}`;
              const response = await userWorker.fetch(new Request(url));
              if (response.ok) {
                const key = isrCacheKey(projectId, deployment.id, pathname);
                const headers = serializePrerenderHeaders(response);
                const body = await response.arrayBuffer();
                const packed = packIsrValue(headers, body);
                await c.env.ISR_CACHE.put(key, packed, {
                  metadata: { s: response.status, c: Date.now(), t: ttl },
                });
              }
            } catch {
              // non-blocking
            }
          });
          emit({ event: 'prerender_done' });
        }
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);

        // Routing switch
        const existingRouting = await c.env.ROUTING.get(project.slug);
        const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
        const dispatchLimits =
          planLimits.cpuMsPerRequest > 0 || planLimits.subRequestsPerInvocation > 0
            ? {
                ...(planLimits.cpuMsPerRequest > 0 ? { cpuMs: planLimits.cpuMsPerRequest } : {}),
                ...(planLimits.subRequestsPerInvocation > 0
                  ? { subRequests: planLimits.subRequestsPerInvocation }
                  : {}),
              }
            : null;
        const routingJson = buildRoutingJson({
          workerName,
          projectId,
          userId: project.user_id,
          manifest,
          deploymentId: deployment.id,
          dispatchLimits,
          suspended: existingEntry?.suspended,
          hasCrons,
          assetManifestId: assetCount > 0 ? deployment.id : undefined,
          assetConfig: assetCount > 0 ? assetConfig : undefined,
        });
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);
        await assertProjectNotDeleting(c.get('db'), projectId);
        markPhase('routing_switch');
        await c.env.ROUTING.put(project.slug, routingJson);
        writtenRoutingKeys.push(project.slug);
        routingSwitched = true;
        logger = logger.with({ routingSwitched: true });
        logger.info('routing_switch', 'slug_routed', { slug: project.slug });

        for (const domain of projectDomains) {
          if (domain.status === 'active') {
            const domainKey = `domain:${domain.hostname}`;
            await c.env.ROUTING.put(domainKey, routingJson);
            writtenRoutingKeys.push(domainKey);
          }
        }

        markPhase('db_finalize');
        logger.info('status_transition', 'status_change', {
          from: currentStatus,
          to: 'live',
          reason: 'wfp_deploy',
        });
        await c.get('db').transaction(async (tx) => {
          await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
          const txDb = tx as unknown as Db;
          const lockedProject = await getProject(txDb, projectId);
          if (!lockedProject || lockedProject.status === 'deleting') {
            throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
          }
          await updateDeploymentStatus(txDb, deployment.id, 'live', undefined, {
            force: true,
          });
          await updateProjectType(
            txDb,
            projectId,
            manifest.type ?? (manifest.framework ? 'framework' : 'void'),
          );
        });
        currentStatus = 'live';
        await setActiveDeployment(c.get('db'), projectId, deployment.id);
        await markDeploymentRetained(c.get('db'), deployment.id, true);

        // Cron sync
        currentStep = 'cron_setup';
        markPhase('cron_sync');
        const cronSyncPromise = (async () => {
          try {
            if (hasCrons) {
              const cronProxyToken = workerBindings.find(
                (b) => b.name === '__VOID_PROXY_TOKEN',
              )?.text;
              await syncCronScheduler(c.env, projectId, {
                workerName,
                schedules: manifest.schedules!,
                proxyToken: cronProxyToken,
              });
            } else {
              await clearCronScheduler(c.env, projectId);
            }
          } catch (err) {
            logger.error('cron_sync', 'cron_sync_failed_post_routing', err);
          }
        })();
        try {
          c.executionCtx.waitUntil(cronSyncPromise);
        } catch {
          await cronSyncPromise;
        }

        // Legacy + retention cleanup (mirror of multipart's WfP path)
        const legacyWorkerName = `user-${project.slug}`;
        await deleteDispatchScript(
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          dispatchNamespace,
          legacyWorkerName,
        );

        markPhase('retention_cleanup');
        const retentionLimit = planLimits.retainedDeployments;
        if (retentionLimit > 0) {
          const retained = await getRetainedDeploymentsExcluding(
            c.get('db'),
            projectId,
            deployment.id,
          );
          const toEvict = retained.slice(retentionLimit - 1);

          // Build the union of hashes that must remain in R2 after this deploy:
          // this deploy's manifest plus every kept retained deployment's
          // manifest. Always built (independent of `toEvict.length`) because
          // the post-eviction R2 keyspace sweep below uses it to opportunistically
          // GC direct-to-R2 orphans (bytes uploaded via presigned PUTs that
          // never finalized into a live deploy).
          const retainedHashes = new Set<string>();
          for (const [, entry] of Object.entries(assetManifest)) {
            retainedHashes.add(entry.hash);
          }
          const keptDeployments = retained.slice(0, retentionLimit - 1);
          for (const kept of keptDeployments) {
            if (kept.asset_hashes) {
              try {
                const keptManifest = JSON.parse(kept.asset_hashes) as Record<
                  string,
                  { hash: string }
                >;
                for (const entry of Object.values(keptManifest)) {
                  retainedHashes.add(entry.hash);
                }
              } catch (e) {
                // A single corrupt asset_hashes blob must not poison the
                // sweep — skip the bad row and keep walking. The orphan sweep
                // is best-effort either way.
                logger.warn('retention_cleanup', 'retained_asset_hashes_parse_failed', {
                  retainedDeploymentId: kept.id,
                  err: e instanceof Error ? e.message : String(e),
                });
              }
            }
          }

          for (const old of toEvict) {
            const evictionSkipped = await c.get('db').transaction(async (tx) => {
              await tx.execute(
                drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
              );
              const txDb = tx as unknown as Db;
              const lockedProject = await getProject(txDb, projectId);
              if (lockedProject?.active_deployment_id === old.id) {
                return true;
              }
              await markDeploymentRetained(txDb, old.id, false);
              return false;
            });
            if (evictionSkipped) {
              continue;
            }

            try {
              const oldWorkerName = `user-${project.slug}-${old.id}`;
              await deleteDispatchScript(
                c.env.CF_ACCOUNT_ID,
                c.env.CF_API_TOKEN,
                dispatchNamespace,
                oldWorkerName,
              ).catch((e) => {
                logger.warn('retention_cleanup', 'evicted_dispatch_script_delete_failed', {
                  evictedDeploymentId: old.id,
                  err: e instanceof Error ? e.message : String(e),
                });
              });
              if (old.asset_hashes) {
                try {
                  const evictedManifest = JSON.parse(old.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  const evictedHashes = Object.values(evictedManifest).map((e) => e.hash);
                  await deleteUnreferencedAssets(
                    c.env.STATIC_ASSETS,
                    c.env.STATIC_ASSETS_R2,
                    evictedHashes,
                    retainedHashes,
                    projectId,
                  ).catch((e) => {
                    logger.warn('retention_cleanup', 'evicted_unreferenced_assets_delete_failed', {
                      evictedDeploymentId: old.id,
                      err: e instanceof Error ? e.message : String(e),
                    });
                  });
                  await c.env.ROUTING.delete(`manifest:${old.id}`).catch((e) => {
                    logger.warn('retention_cleanup', 'evicted_routing_manifest_delete_failed', {
                      evictedDeploymentId: old.id,
                      err: e instanceof Error ? e.message : String(e),
                    });
                  });
                } catch (e) {
                  logger.warn('retention_cleanup', 'evicted_asset_hashes_parse_failed', {
                    evictedDeploymentId: old.id,
                    err: e instanceof Error ? e.message : String(e),
                  });
                }
              }
              if (old.manifest) {
                try {
                  const oldManifest = JSON.parse(old.manifest) as DeployManifest;
                  if (oldManifest.sandbox) {
                    const oldContainerAppName = perDeployContainerApplicationName(
                      projectId,
                      old.id,
                      oldManifest.sandbox.containerName ?? 'void-sandbox',
                    );
                    const existing = await findContainerApplication(
                      c.env.CF_ACCOUNT_ID,
                      c.env.CF_API_TOKEN,
                      oldContainerAppName,
                    );
                    if (existing) {
                      await deleteContainerApplicationIdempotent(
                        c.env.CF_ACCOUNT_ID,
                        c.env.CF_API_TOKEN,
                        existing.id,
                      );
                    }
                  }
                } catch (e) {
                  logger.error('retention_cleanup', 'evicted_sandbox_container_delete_failed', e, {
                    evictedDeploymentId: old.id,
                  });
                }
              }
              if (old.bundle_stored) {
                try {
                  await deleteWorkerBundle(c.env.STATIC_ASSETS_R2, projectId, old.id);
                } catch (e) {
                  logger.error('retention_cleanup', 'evicted_worker_bundle_delete_failed', e, {
                    evictedDeploymentId: old.id,
                  });
                }
              }
              await clearIsrCache(c.env.ISR_CACHE, projectId, old.id).catch((e) =>
                logger.error('retention_cleanup', 'evicted_isr_cache_clear_failed', e, {
                  evictedDeploymentId: old.id,
                }),
              );
            } catch (e) {
              logger.warn('retention_cleanup', 'eviction_partial_failure', {
                evictedDeploymentId: old.id,
                err: e instanceof Error ? e.message : String(e),
              });
              continue;
            }
          }

          // Direct-to-R2 orphan sweep. The eviction loop above only deletes
          // hashes named in the EVICTED deployments' `asset_hashes` — bytes
          // uploaded via direct-to-R2 presigned PUTs that never finalized
          // into a live deploy were never named in any manifest, so they
          // outlive the eviction loop. Walk the project's R2 keyspace and
          // drop anything not in `retainedHashes`. Best-effort: a failed
          // sweep should not fail the deploy.
          try {
            const orphans = await sweepProjectAssetOrphans(
              c.env.STATIC_ASSETS_R2,
              projectId,
              retainedHashes,
            );
            if (orphans > 0) {
              logger.info('retention_cleanup', 'r2_orphans_swept', { count: orphans });
            }
          } catch (e) {
            logger.warn('retention_cleanup', 'r2_orphan_sweep_failed', {
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
        const activeDomains = projectDomains.filter((d) => d.status === 'active');
        const fullUrl =
          activeDomains.length > 0
            ? `https://${activeDomains[0].hostname}`
            : `https://${project.slug}.${siteDomain}`;

        emit({
          event: 'done',
          deployment: deployment.id,
          url: fullUrl,
          urls: [
            ...activeDomains.map((d) => `https://${d.hostname}`),
            `https://${project.slug}.${siteDomain}`,
          ],
          assets: assetCount,
          workers: workerFiles.length,
          ...(migrationsApplied > 0 && { migrations: migrationsApplied }),
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = sanitizeDeployErrorMessage(raw);
        if (msg !== raw) {
          logger.error('catch', 'raw_error_before_sanitization', err, {
            workerName,
            currentPhase: currentStep,
          });
        }
        logger.error('catch', 'pipeline_error', err, {
          currentPhase: currentStep,
          routingSwitched,
          workerUploaded,
          bundleStored,
        });

        // Wfp mirror manifest cleanup on pre-routing failure (mirror of
        // multipart `cleanupStreamedAssetsOnAbort`'s mirror-only branch).
        if (!routingSwitched && wfpMirroredManifestDeploymentId) {
          const id = wfpMirroredManifestDeploymentId;
          wfpMirroredManifestDeploymentId = null;
          await c.env.ROUTING.delete(`manifest:${id}`).catch((e) =>
            logger.warn('catch', 'mirrored_manifest_evict_failed', {
              deploymentId: id,
              err: e instanceof Error ? e.message : String(e),
            }),
          );
        }

        const failedDeployment = deployment!;
        const failedManifest = manifest!;
        const failedWorkerName = workerName!;
        const failedDispatchNamespace = dispatchNamespace!;

        const teardownRaceLost = routingSwitched && raw === PROJECT_DELETING_ERROR_MESSAGE;
        if (teardownRaceLost) {
          logger.error('catch', 'teardown_race_lost', err, {
            workerName: failedWorkerName,
            writtenRoutingKeyCount: writtenRoutingKeys.length,
          });
          for (const key of writtenRoutingKeys) {
            await c.env.ROUTING.delete(key).catch((e) =>
              logger.error('catch', 'routing_rollback_failed', e, { key }),
            );
          }
          if (workerUploaded && workerUploadUrl) {
            await fetch(workerUploadUrl, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` },
            }).catch((e) =>
              logger.error('catch', 'orphan_worker_delete_failed', e, {
                workerName: failedWorkerName,
              }),
            );
          }
          if (bundleStored) {
            await deleteWorkerBundle(c.env.STATIC_ASSETS_R2, projectId, failedDeployment.id).catch(
              (e) =>
                logger.error('catch', 'worker_bundle_delete_failed', e, {
                  deploymentId: failedDeployment.id,
                }),
            );
          }
          if (sandboxContainerAppId) {
            await deleteContainerApplicationWithRetry(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              sandboxContainerAppId,
            );
          } else if (sandboxContainerAppName) {
            try {
              const orphan = await findContainerApplication(
                c.env.CF_ACCOUNT_ID,
                c.env.CF_API_TOKEN,
                sandboxContainerAppName,
              );
              if (orphan) {
                await deleteContainerApplicationWithRetry(
                  c.env.CF_ACCOUNT_ID,
                  c.env.CF_API_TOKEN,
                  orphan.id,
                );
              }
            } catch (e) {
              logger.error('catch', 'orphan_container_recovery_failed', e, {
                sandboxContainerAppName,
              });
            }
          }
          logger.info('status_transition', 'status_change', {
            deploymentId: failedDeployment.id,
            from: currentStatus,
            to: 'failed',
            reason: 'teardown_race_lost',
          });
          await updateDeploymentStatus(c.get('db'), failedDeployment.id, 'failed', msg).catch(
            () => {},
          );
          currentStatus = 'failed';
          emit({ event: 'error', message: msg, step: currentStep });
        } else if (routingSwitched) {
          logger.error('catch', 'post_routing_step_failed', err, {
            workerName: failedWorkerName,
            currentPhase: currentStep,
          });
          logger.info('status_transition', 'status_change', {
            deploymentId: failedDeployment.id,
            from: currentStatus,
            to: 'live',
            reason: 'post_routing_recovery',
          });
          await updateDeploymentStatus(c.get('db'), failedDeployment.id, 'live', undefined, {
            force: true,
          }).catch(() => {});
          currentStatus = 'live';
          await updateProjectType(
            c.get('db'),
            projectId,
            failedManifest.type ?? (failedManifest.framework ? 'framework' : 'void'),
          ).catch(() => {});
          await setActiveDeployment(c.get('db'), projectId, failedDeployment.id).catch(() => {});
          await markDeploymentRetained(c.get('db'), failedDeployment.id, true).catch(() => {});
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          const slugUrl = `https://${project.slug}.${siteDomain}`;
          emit({
            event: 'done',
            deployment: failedDeployment.id,
            url: slugUrl,
            urls: [slugUrl],
            assets: 0,
            workers: 0,
          });
        } else {
          const latest = await getDeployment(c.get('db'), failedDeployment.id);
          const wasCanceled =
            latest && CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status);
          for (const key of writtenRoutingKeys) {
            await c.env.ROUTING.delete(key).catch((e) =>
              logger.error('catch', 'routing_rollback_failed', e, { key }),
            );
          }
          await deleteDispatchScript(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            failedDispatchNamespace,
            failedWorkerName,
          ).catch((e) =>
            logger.error('catch', 'worker_script_cleanup_failed', e, {
              workerName: failedWorkerName,
            }),
          );
          if (bundleStored) {
            await deleteWorkerBundle(c.env.STATIC_ASSETS_R2, projectId, failedDeployment.id).catch(
              (e) =>
                logger.error('catch', 'worker_bundle_delete_failed', e, {
                  deploymentId: failedDeployment.id,
                }),
            );
          }
          if (sandboxContainerAppId) {
            await deleteContainerApplicationWithRetry(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              sandboxContainerAppId,
            );
          } else if (sandboxContainerAppName) {
            try {
              const orphan = await findContainerApplication(
                c.env.CF_ACCOUNT_ID,
                c.env.CF_API_TOKEN,
                sandboxContainerAppName,
              );
              if (orphan) {
                await deleteContainerApplicationWithRetry(
                  c.env.CF_ACCOUNT_ID,
                  c.env.CF_API_TOKEN,
                  orphan.id,
                );
              }
            } catch (e) {
              logger.error('catch', 'orphan_container_recovery_failed', e, {
                sandboxContainerAppName,
              });
            }
          }
          await clearIsrCache(c.env.ISR_CACHE, projectId, failedDeployment.id).catch((e) =>
            logger.error('catch', 'isr_cache_clear_failed', e, {
              deploymentId: failedDeployment.id,
            }),
          );
          logger.info('status_transition', 'status_change', {
            deploymentId: failedDeployment.id,
            from: currentStatus,
            to: wasCanceled ? 'canceled' : 'failed',
            reason: 'pre_routing_failure',
            wasCanceled,
          });
          if (!wasCanceled) {
            await updateDeploymentStatus(c.get('db'), failedDeployment.id, 'failed', msg);
            currentStatus = 'failed';
          } else {
            await updateDeploymentStatus(c.get('db'), failedDeployment.id, 'canceled', msg, {
              force: true,
            });
            currentStatus = 'canceled';
          }
          emit({ event: 'error', message: msg, step: currentStep });
          if (!wasCanceled && c.env.EMAIL && user.email) {
            const dashboardUrl = c.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
            c.executionCtx.waitUntil(
              sendDeployFailedEmail(c.env.EMAIL, user.email, project.slug, msg, dashboardUrl).catch(
                (err) =>
                  logger.error('catch', 'failed_email_send_failed', err, {
                    projectSlug: project.slug,
                  }),
              ),
            );
          }
        }
      }
    } catch (err) {
      logger.error('catch', 'unhandled_pipeline_error', err, { currentPhase: currentStep });
      emit({
        event: 'error',
        message: 'deploy failed due to an internal error',
        step: currentStep,
      });
    } finally {
      clearInterval(heartbeat);
      // Reap the placeholder deployment row if it never advanced past the
      // initial 'pending' + null-manifest state. Same invariant as
      // multipart: a row stuck at 'pending' with a manifest set is the
      // bug class we want surfaced.
      //
      // A `canceling` placeholder means a `cancelDeployment` API call
      // raced an early-return path (asset-verify failure, quota check,
      // etc.) AFTER the precheck-and-claim insert but BEFORE the manifest
      // update. The two-phase cancellation flip sets status='canceling'
      // but the pipeline's catch never reached a force-finalize path.
      // DELETE alongside `pending` placeholders — both represent no real
      // deploy attempt (manifest is still null).
      try {
        const latest = await getDeployment(c.get('db'), preDeployment.id);
        if (
          latest &&
          (latest.status === 'pending' || latest.status === 'canceling') &&
          latest.manifest === null
        ) {
          await c.get('db').delete(deployments).where(eq(deployments.id, preDeployment.id));
          logger.info('placeholder_reap', 'placeholder_deleted', {
            placeholderId: preDeployment.id,
            priorStatus: latest.status,
          });
        } else if (latest && latest.status === 'pending' && latest.manifest !== null) {
          logger.warn('placeholder_reap', 'stranded_pending_row', {
            placeholderId: preDeployment.id,
            latestStatus: latest.status,
            hasManifest: latest.manifest !== null,
          });
        }
      } catch (err) {
        logger.warn('placeholder_reap', 'reap_failed', {
          placeholderId: preDeployment.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      streamOpen = false;
      try {
        await writer.close();
      } catch {
        // ignore
      }
    }
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

// Deploy preflight — returns which assets need uploading based on diff with last deploy
app.post('/:id/deploy/preflight', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // Mirror /upload-urls and handleManifestOnlyDeploy: short-circuit when
  // the project is being torn down so callers get the more specific 410
  // before any body parsing or version-gate work. A stale CLI on a
  // deleting project should see "project is being deleted", not "upgrade
  // your CLI" — upgrading won't make the project come back.
  if (project.status === 'deleting') {
    return c.json({ error: 'project is being deleted' }, 410);
  }
  // CLI version gate runs AFTER project authz + status so a stale CLI
  // hitting a missing/foreign/deleting project gets the more specific
  // 404/403/410 first instead of a misleading "upgrade your CLI" 426.
  const versionReject = checkCliVersionOrRespond(c);
  if (versionReject) {
    return versionReject;
  }

  const body = await c.req.json<{
    assetManifest: Record<string, { hash: string; size: number }>;
    hasWorker?: boolean;
  }>();
  const { assetManifest, hasWorker } = body;
  const total = Object.keys(assetManifest).length;

  const prevManifest = await getLastLiveAssetManifest(c.get('db'), projectId);

  if (!prevManifest) {
    return c.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
  }

  // Preflight dedup is only safe when both the previous and current deploys
  // use the same asset backend (KV/R2 for static, CF asset API for WfP).
  // Read the live routing entry as the source of truth: it is what is
  // actually serving traffic and survives post-routing recovery paths that
  // silently swallow a failed `updateProjectType`. Presence of
  // `staticDeploymentId` in the entry means the active backend is static
  // (KV/R2); anything else — including a missing or malformed entry — is
  // treated as non-static so we conservatively return all assets.
  if (project.active_deployment_id) {
    const routingRaw = await c.env.ROUTING.get(project.slug);
    let prevIsStatic = false;
    if (routingRaw) {
      try {
        const parsed = JSON.parse(routingRaw) as { staticDeploymentId?: unknown };
        prevIsStatic = typeof parsed.staticDeploymentId === 'string';
      } catch {
        // malformed routing entry — treat as non-static, safe default
      }
    }
    const currentIsStatic = !hasWorker;
    if (!(prevIsStatic && currentIsStatic)) {
      // Backend transition, or previous deploy was WfP whose bytes live
      // in CF's asset store (preflight cannot safely dedup those).
      return c.json({ needed: Object.keys(assetManifest), total, skipped: 0 });
    }
  }

  const needed: Array<string> = [];
  for (const [path, entry] of Object.entries(assetManifest)) {
    const prev = prevManifest[path];
    if (!prev || prev.hash !== entry.hash) {
      needed.push(path);
    }
  }

  return c.json({ needed, total, skipped: total - needed.length });
});

export async function clearIsrCache(
  kv: KVNamespace,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  // `deploymentId` is required so a bare call cannot fall through to the
  // project-wide prefix and wipe every deployment's ISR namespace.
  const prefix = isrCachePrefix(projectId, deploymentId);
  let cursor: string | undefined;

  do {
    const listed = await kv.list({ prefix, cursor });
    if (listed.keys.length > 0) {
      await uploadPool(listed.keys, R2_CONCURRENCY, (key) => kv.delete(key.name));
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

// --- ISR prerender helpers (inlined from dispatch to avoid cross-package dependency) ---

/**
 * Pack response headers + body into a single ArrayBuffer.
 * Format: [4 bytes uint32 LE header length][UTF-8 header JSON][raw body]
 */
function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/**
 * Resolve the ISR TTL for a given pathname.
 * For object form, first matching pattern wins.
 */
function resolvePathTtl(
  revalidate: number | Record<string, number> | undefined,
  pathname: string,
): number {
  if (revalidate == null) {
    return 0;
  }
  if (typeof revalidate === 'number') {
    return revalidate;
  }
  for (const [pattern, ttl] of Object.entries(revalidate)) {
    if (matchLiteralPattern(pattern, pathname)) {
      return ttl;
    }
  }
  return 0;
}

const MAX_CACHE = 256;
const regexCache = new Map<string, RegExp>();

/**
 * Match a pattern against a pathname using LITERAL semantics —
 * only `*` is special (matches any characters including `/`); every other
 * character (including `:`) is treated as a literal.
 *
 * Mirrors `matchLiteralPattern` in `packages/dispatch/src/pattern.ts`. Keep
 * the two implementations in sync — `routing.revalidate` keys are written
 * here (during deploy/prerender) and read by dispatch, so both sides must
 * agree on what each pattern matches.
 */
function matchLiteralPattern(pattern: string, pathname: string): boolean {
  let regex = regexCache.get(pattern);
  if (regex) {
    regexCache.delete(pattern);
    regexCache.set(pattern, regex);
  } else {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    regex = new RegExp(`^${escaped}$`);
    if (regexCache.size >= MAX_CACHE) {
      regexCache.delete(regexCache.keys().next().value!);
    }
    regexCache.set(pattern, regex);
  }
  return regex.test(pathname);
}

/**
 * Extract response headers as a plain object, skipping ISR-managed headers.
 */
function serializePrerenderHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  const skip = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

  response.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}

function moduleContentType(filename: string): string {
  if (filename.endsWith('.wasm')) {
    return 'application/wasm';
  }
  if (filename.endsWith('.map')) {
    return 'application/source-map';
  }
  if (filename.endsWith('.json')) {
    return 'application/json';
  }
  if (filename.endsWith('.txt')) {
    return 'text/plain';
  }
  return 'application/javascript+module';
}

export default app;
