import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  applyDeclaredAssetManifest,
  AssetHashMismatchError,
  cleanupStreamedStaticAssets,
  collectBufferedAsset,
  computeAssetHash,
  createAssetUploadSession,
  KV_THRESHOLD,
  readStaticAssetPart,
  STATIC_ASSET_UPLOAD_CONCURRENCY,
  streamStaticAssetToR2,
  uploadAssetBuckets,
  uploadStaticAssetPart,
  buildAssetMetadata,
  uploadStaticAssets,
  deleteUnreferencedAssets,
  verifyStreamedAssetPart,
  getContentType,
  type AssetEntry,
  type AssetManifestEntry,
} from '../assets';
import { deleteDispatchScript, retryWithBackoff } from '../cf-api';
import { R2_CONCURRENCY, uploadPool } from '../concurrency';
import { SITE_DOMAIN } from '../constants';
import { DEFAULT_DASHBOARD_URL } from '../constants';
import {
  getProject,
  getDeployment,
  createDeployment,
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
  setAppliedMigrations,
  getRetainedDeployments,
  getRetainedDeploymentsExcluding,
  getProjectSecrets,
  upsertProjectSecret,
  CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES,
  type Db,
} from '../db';
import { sendDeployFailedEmail } from '../email';
import type { ApiEnv } from '../env';
import { isrCacheKey, isrCachePrefix } from '../isr-cache';
import {
  MultipartParseError,
  parseBoundary,
  parseMultipart,
  PartTooLargeError,
} from '../multipart';
import {
  BETTER_AUTH_SECRET_NAME,
  decryptProjectSecret,
  generateManagedAuthSecret,
  encryptProjectSecret,
} from '../project-secrets';
import { addQueueConsumer } from '../provisioning/cloudflare-api';
import { provisionBindings } from '../provisioning/provision';
import { buildRoutingJson, buildStaticRoutingJson } from '../routing';
import { deployments } from '../schema';
import { getPlanLimits, isWithinLimit, STATIC_RETENTION_LIMIT } from '../tiers';
import { SUPPORTED_MANIFEST_VERSIONS, type DeployManifest, type DeployEvent } from '../types';
import type { WebSocketMigrationMeta } from '../types';

const DEFAULT_DISPATCH_NAMESPACE = 'void-users';

// Per-part byte caps for buffered text fields. The Cloudflare Workers request
// budget is 128 MiB, and these parts are fully buffered in memory before
// `validateManifestShape` can run — so we must refuse oversized inputs before
// we allocate. Numbers below are generous for legitimate deploys while still
// bounding any single buffered allocation well under the request budget.
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024; // 8 MiB — DeployManifest JSON
const MAX_ASSET_MANIFEST_BYTES = 32 * 1024 * 1024; // 32 MiB — per-asset records for huge static sites
const MAX_PREFLIGHT_BYTES = 1 * 1024 * 1024; // 1 MiB — preflight metadata
const MAX_SMALL_TEXT_BYTES = 64 * 1024; // 64 KiB — source, commit, misc
// CF's worker script size limit (free plan 1 MiB, paid plan 10 MiB compressed;
// uncompressed/multipart headroom is roughly 32 MiB). Enforced per part so a
// single runaway worker:* module cannot OOM the request before the upload to
// CF ever happens.
const MAX_WORKER_FILE_BYTES = 32 * 1024 * 1024; // 32 MiB
// There is no aggregate in-memory cap on buffered deploy payloads: the
// direct-to-R2 streaming path handles the large-asset case with O(1)
// residency, and per-part caps above (plus the 128 MiB Worker isolate
// memory hard wall) are the only remaining backstops for buffered paths
// (worker-backed asset uploads and the streamed-static pool for small
// assets). A deploy that buffers many legally-sized parts may approach
// the 128 MiB isolate budget; that is accepted as the user's own risk.
const STREAMED_ASSET_CLAIM_PREFIX = 'deploy-asset-claim';
const STREAMED_ASSET_CLAIM_TTL_SECONDS = 60 * 60;
/**
 * Detect the known CF WfP bug where APIs return plain text about asset state
 * instead of JSON. CF returns different messages depending on propagation state
 * (e.g. "Assets have already been uploaded", "Assets have not yet been deployed").
 * Valid JSON always starts with `{` or `[`, so `startsWith` avoids false positives.
 */
function isCfAssetPlainText(text: string): boolean {
  return text.trimStart().startsWith('Assets have');
}

const CF_RETRY = { maxRetries: 3, delayMs: 1000 };
// Readiness probe: confirms the new worker is live in the dispatch namespace
// before dispatching migrations. Absorbs CF's WfP propagation delay.
// Backoff: 0 + 1 + 2 + 4 + 8 + 16 + 32 = ~63s max window.
const CF_READINESS_RETRY = { maxRetries: 6, delayMs: 1000 };
// Migration dispatch: propagation lag is handled by the readiness probe,
// so this only retries genuine transient failures (e.g. network blips).
const CF_MIGRATION_RETRY = { maxRetries: 2, delayMs: 1000 };

const app = new Hono<ApiEnv>();

/**
 * Read a multipart part body up to `maxBytes`. Throws `PartTooLargeError` as
 * soon as the cap is exceeded — we stop reading rather than draining the
 * remainder, so abandoning the stream does NOT buffer past the cap.
 */
async function readPartBytes(
  body: ReadableStream<Uint8Array>,
  partName: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        throw new PartTooLargeError(partName, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be in a terminal state; nothing to release.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function readPartText(
  body: ReadableStream<Uint8Array>,
  partName: string,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readPartBytes(body, partName, maxBytes));
}

async function discardPartBody(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be in a terminal state; nothing to release.
    }
  }
}

/**
 * Read a multipart part body directly into a `Blob` with the given content
 * type. Same per-part cap semantics as `readPartBytes`, but never exposes a
 * merged `Uint8Array` to the caller — the chunks are handed straight to the
 * `Blob` constructor inside this function, and only the resulting `Blob`
 * escapes.
 *
 * Why this exists instead of `new Blob([await readPartBytes(...)])`:
 * `new Blob([uint8])` always copies the source bytes, so that two-step form
 * momentarily holds two full-size copies (the returned `Uint8Array` AND the
 * `Blob`'s internal buffer). When the caller reads several large worker
 * modules in a `for await` loop, V8 may not reclaim the previous iteration's
 * dead `const bytes` binding before the next parse begins — pushing the
 * per-request peak toward the 128 MiB Worker budget. Keeping the raw chunks
 * strictly local to this function means the caller's loop body never names a
 * `Uint8Array` that could survive into the next iteration.
 */
async function readPartAsBlob(
  body: ReadableStream<Uint8Array>,
  partName: string,
  maxBytes: number,
  contentType: string,
): Promise<Blob> {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        throw new PartTooLargeError(partName, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be in a terminal state; nothing to release.
    }
  }
  // Hand chunks directly to the Blob constructor — no merged-Uint8Array
  // intermediary. `chunks` is strictly local to this function and becomes
  // unreachable when we return, so the caller never holds a raw byte buffer
  // that could survive into the next iteration of a buffering loop. The
  // `as BlobPart[]` cast exists because lib.dom types widen `Uint8Array`'s
  // buffer to `ArrayBufferLike`, which includes `SharedArrayBuffer` and is
  // not directly assignable to `BlobPart`. Our chunks come from a
  // `ReadableStream<Uint8Array>` reader — never shared memory.
  return new Blob(chunks as unknown as Array<BlobPart>, { type: contentType });
}

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
function validateManifestShape(parsed: unknown): string | null {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'invalid manifest shape: expected a JSON object';
  }
  const m = parsed as Record<string, unknown>;

  if (m.bindings == null || typeof m.bindings !== 'object' || Array.isArray(m.bindings)) {
    return 'invalid manifest shape: bindings must be an object';
  }
  const b = m.bindings as Record<string, unknown>;
  for (const key of ['d1', 'kv', 'r2', 'hyperdrive'] as const) {
    const v = b[key];
    if (v === undefined) {
      continue;
    }
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      return `invalid manifest shape: bindings.${key} must be an array of strings`;
    }
  }

  if (m.queues !== undefined) {
    if (!Array.isArray(m.queues)) {
      return 'invalid manifest shape: queues must be an array';
    }
    for (const q of m.queues) {
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

  if (m.schedules !== undefined) {
    if (!Array.isArray(m.schedules)) {
      return 'invalid manifest shape: schedules must be an array';
    }
    for (const s of m.schedules) {
      if (s == null || typeof s !== 'object' || Array.isArray(s)) {
        return 'invalid manifest shape: schedules entries must be objects';
      }
      const so = s as Record<string, unknown>;
      if (typeof so.name !== 'string' || typeof so.cron !== 'string') {
        return 'invalid manifest shape: schedules entries must have string name and cron';
      }
    }
  }

  if (m.prerender !== undefined) {
    if (!Array.isArray(m.prerender) || !m.prerender.every((x) => typeof x === 'string')) {
      return 'invalid manifest shape: prerender must be an array of strings';
    }
  }

  if (m.vars !== undefined) {
    if (m.vars == null || typeof m.vars !== 'object' || Array.isArray(m.vars)) {
      return 'invalid manifest shape: vars must be an object';
    }
    for (const [k, v] of Object.entries(m.vars as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return `invalid manifest shape: vars.${k} must be a string`;
      }
    }
  }

  if (m.migrations !== undefined) {
    if (m.migrations == null || typeof m.migrations !== 'object' || Array.isArray(m.migrations)) {
      return 'invalid manifest shape: migrations must be an object';
    }
    const mig = m.migrations as Record<string, unknown>;
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

  if (m.auth !== undefined && typeof m.auth !== 'boolean') {
    return 'invalid manifest shape: auth must be a boolean';
  }

  if (m.ssr !== undefined && typeof m.ssr !== 'boolean') {
    return 'invalid manifest shape: ssr must be a boolean';
  }

  for (const key of [
    'workerMain',
    'compatibilityDate',
    'hashedAssetsPrefix',
    'framework',
  ] as const) {
    if (m[key] !== undefined && typeof m[key] !== 'string') {
      return `invalid manifest shape: ${key} must be a string`;
    }
  }

  if (m.compatibilityFlags !== undefined) {
    if (
      !Array.isArray(m.compatibilityFlags) ||
      !m.compatibilityFlags.every((x) => typeof x === 'string')
    ) {
      return 'invalid manifest shape: compatibilityFlags must be an array of strings';
    }
  }

  if (m.type !== undefined) {
    const allowed = ['void', 'spa', 'static', 'framework'];
    if (typeof m.type !== 'string' || !allowed.includes(m.type)) {
      return `invalid manifest shape: type must be one of ${allowed.join(', ')}`;
    }
  }

  if (m.assetConfig !== undefined) {
    if (
      m.assetConfig == null ||
      typeof m.assetConfig !== 'object' ||
      Array.isArray(m.assetConfig)
    ) {
      return 'invalid manifest shape: assetConfig must be an object';
    }
    const ac = m.assetConfig as Record<string, unknown>;
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

  if (m.revalidate !== undefined) {
    if (typeof m.revalidate === 'number') {
      // ok
    } else if (
      m.revalidate == null ||
      typeof m.revalidate !== 'object' ||
      Array.isArray(m.revalidate)
    ) {
      return 'invalid manifest shape: revalidate must be a number or object';
    } else {
      for (const [k, v] of Object.entries(m.revalidate as Record<string, unknown>)) {
        if (typeof v !== 'number') {
          return `invalid manifest shape: revalidate.${k} must be a number`;
        }
      }
    }
  }

  if (m.headerRules !== undefined) {
    if (!Array.isArray(m.headerRules)) {
      return 'invalid manifest shape: headerRules must be an array';
    }
    for (const rule of m.headerRules) {
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

  if (m.redirectRules !== undefined) {
    if (!Array.isArray(m.redirectRules)) {
      return 'invalid manifest shape: redirectRules must be an array';
    }
    for (const rule of m.redirectRules) {
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
      const allowedStatuses = [301, 302, 303, 307, 308];
      if (!allowedStatuses.includes(ro.status)) {
        return `invalid manifest shape: redirectRules entry status must be one of ${allowedStatuses.join(', ')}`;
      }
    }
  }

  if (m.websocket !== undefined) {
    if (m.websocket == null || typeof m.websocket !== 'object' || Array.isArray(m.websocket)) {
      return 'invalid manifest shape: websocket must be an object';
    }
    const ws = m.websocket as Record<string, unknown>;
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

  return null;
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

function streamedAssetClaimKey(projectId: string, hash: string, token: string): string {
  return `${STREAMED_ASSET_CLAIM_PREFIX}:${projectId}:${hash}:${token}`;
}

async function assertDeploymentNotCanceled(db: Db, deploymentId: string): Promise<void> {
  const latest = await getDeployment(db, deploymentId);
  if (latest && CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status)) {
    throw new Error('deployment canceled');
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

// Deploy to a project
app.post('/:id/deploy', async (c) => {
  const projectId = c.req.param('id');
  const project = await getProject(c.get('db'), projectId);
  if (!project) {
    return c.json({ error: 'project not found' }, 404);
  }

  if (project.user_id !== c.get('user').id) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Admin suspensions are already blocked by authMiddleware → 403. Usage-limit
  // suspensions (requests_exceeded) must remain able to deploy so users can
  // ship fixes and roll back while their limits reset.

  // Run independent pre-checks in parallel
  const [activeDeploy, currentLiveDeployment] = await Promise.all([
    getActiveDeployment(c.get('db'), projectId),
    project.active_deployment_id
      ? getDeployment(c.get('db'), project.active_deployment_id)
      : Promise.resolve(null),
  ]);
  const user = c.get('user');

  // Reject concurrent deploys to the same project
  if (activeDeploy) {
    // Normalize timestamp to ISO 8601 for safe Date parsing.
    // PostgreSQL returns ISO format; also handles legacy format (space separator, no Z).
    const createdAt = activeDeploy.created_at.includes('T')
      ? activeDeploy.created_at
      : activeDeploy.created_at.replace(' ', 'T') + 'Z';
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs < 10 * 60 * 1000) {
      return c.json({ error: 'deploy in progress', deployment: activeDeploy.id }, 409);
    }
    // Stale — auto-fail and proceed
    await updateDeploymentStatus(
      c.get('db'),
      activeDeploy.id,
      activeDeploy.status === 'canceling' ? 'canceled' : 'failed',
      'timed out',
      activeDeploy.status === 'canceling' ? { force: true } : undefined,
    );
  }

  // The daily deploy-count limit is evaluated in two places depending on the
  // deploy mode:
  //   - worker-backed deploys: post-parse, AFTER the static no-op dedupe
  //     branch, so an identical retry at the cap still returns the existing
  //     live deployment.
  //   - streamed-static deploys: immediately after the manifest part is
  //     parsed, BEFORE any `asset:*` parts are written to KV/R2, so an
  //     over-quota user never pays storage write cost for a rejected request.
  const planLimits = getPlanLimits(user.plan);

  // Stream the multipart body instead of buffering it via c.req.formData(),
  // which would decode every asset blob into Worker memory at once and OOM
  // on media-heavy deploys. Small text parts and worker modules are still
  // buffered (they are tiny). For static deploys (manifest.type === 'spa' |
  // 'static') asset parts are piped straight into KV/R2 as they arrive so
  // peak memory is bounded by one asset at a time. For other deploy modes
  // assets fall back to being buffered into a hash map, matching the old
  // behaviour so the CF asset upload session can consume them later.
  let manifestRaw: string | null = null;
  let incomingManifest: DeployManifest | null = null;
  let incomingAssetManifestRaw: string | null = null;
  // Declared asset manifest parsed eagerly when the `assetManifest` part
  // arrives. Used by the streamed-static `asset:*` fast-path to detect
  // duplicate paths that map to a hash already being processed this
  // request — those bodies are drained without buffering or re-hashing,
  // eliminating a redundant memory allocation for the duplicate. Left
  // `null` if the client never sends `assetManifest` (the fast-path
  // simply never activates and the full read path handles every asset
  // as before).
  let declaredAssetManifest: Record<string, AssetManifestEntry> | null = null;
  let source: string | null = null;
  let commit: string | null = null;
  let preflightRaw: string | null = null;
  // Worker modules are stored as a `Blob` built once, inside `readPartAsBlob`,
  // from the raw chunks. We never name a `Uint8Array` in the parse loop, so
  // there is no per-iteration `const bytes` that could survive into the next
  // parse before GC. The upload loop below also reuses these Blobs directly
  // without re-wrapping — so each worker module only ever exists as a single
  // full-size byte copy inside its `Blob`, rather than doubling to ~2x during
  // the upload step (the exact per-request OOM class this branch hardens
  // against).
  const workerFiles: Array<{ name: string; content: Blob }> = [];
  const assetsByHash = new Map<string, AssetEntry>();
  const builtAssetManifest: Record<string, AssetManifestEntry> = {};
  const streamedHashStores = new Map<string, 'kv' | 'r2'>();
  const streamedLargeHashes = new Set<string>();
  // Deployment id whose WfP safety-net serving manifest (`manifest:{id}` in
  // ROUTING KV) was written by this request. Tracked so the abort path can
  // delete it if the deploy fails before routing switches. See
  // meta/design-docs/0066.
  let wfpMirroredManifestDeploymentId: string | null = null;
  // Bounded-concurrency upload pool for streamed static assets. The parse
  // loop reads one part's bytes inline, then fans the KV/R2 PUT off into a
  // task tracked by both sets. `inFlightStaticUploads` gates the pool
  // (`while (size >= STATIC_ASSET_UPLOAD_CONCURRENCY) await Promise.race
  // (...)`); `staticUploadPromises` keeps a permanent reference so that a
  // task which settles (and deletes itself from the in-flight set) before
  // the post-parse drain still surfaces its rejection via Promise.all. This
  // split is what keeps the upstream multipart reader draining while PUTs
  // are in flight — the bug that previously caused "Connection lost during
  // deploy" on asset-heavy payloads.
  const inFlightStaticUploads = new Set<Promise<void>>();
  const staticUploadPromises: Array<Promise<void>> = [];
  // Per-hash in-flight dedupe for the upload pool. Keyed by content hash,
  // value is the outstanding KV/R2 PUT promise for that hash. Without this
  // map two concurrent pool tasks with identical content would both miss
  // the post-settle `streamedHashStores` cache (only populated once an
  // upload resolves) and both issue a full PUT, doubling cost and
  // inflating `newStaticAssetCount`. See `uploadStaticAssetPart` in
  // `src/assets.ts` for the sync check-then-set atomicity guarantee.
  const inFlightUploadByHash = new Map<string, Promise<'kv' | 'r2'>>();
  let hasWorkerFiles = false;
  let manifestSeen = false;
  let streamedStaticAssets = false;
  let newStaticAssetCount = 0;
  let deferredParseErrorMessage: string | null = null;
  let cleanupExcludeDeploymentId: string | null = null;
  const streamedAssetClaimToken = crypto.randomUUID();
  const claimedStreamedHashes = new Set<string>();

  const ensureStreamedAssetClaim = async (hash: string): Promise<void> => {
    if (claimedStreamedHashes.has(hash)) {
      return;
    }
    await c.env.ROUTING.put(streamedAssetClaimKey(projectId, hash, streamedAssetClaimToken), '1', {
      expirationTtl: STREAMED_ASSET_CLAIM_TTL_SECONDS,
    });
    claimedStreamedHashes.add(hash);
  };

  // Wait for any still-running pool tasks from the streamed-static upload
  // path to settle. Invoked from the two cleanup helpers so every abort
  // path — parse-loop early returns, the catch block, post-parse validation
  // failures — converges on the same invariant: no KV/R2 PUT or claim
  // write is in flight when we start deleting. After this returns each
  // task's `.finally(() => inFlightStaticUploads.delete(task))` has run,
  // so a second call from the second cleanup helper is a cheap no-op.
  const drainInFlightStaticUploads = async (): Promise<void> => {
    if (inFlightStaticUploads.size > 0) {
      await Promise.allSettled(inFlightStaticUploads);
    }
  };

  const cleanupOwnStreamedAssetClaims = async (): Promise<void> => {
    // Drain first: pool tasks call `ensureStreamedAssetClaim` via
    // `onHashed`, which writes to ROUTING KV. Deleting claims before those
    // writes finish would let a late PUT re-publish a claim we just
    // deleted, leaking an orphan until its TTL expires.
    await drainInFlightStaticUploads();
    if (claimedStreamedHashes.size === 0) {
      return;
    }
    await Promise.allSettled(
      Array.from(claimedStreamedHashes, (hash) =>
        c.env.ROUTING.delete(streamedAssetClaimKey(projectId, hash, streamedAssetClaimToken)),
      ),
    );
    claimedStreamedHashes.clear();
  };

  /**
   * Delete assets that were streamed into KV/R2 during a failed/rejected parse.
   * Uses retained-deployment hashes as a safety net: content-addressed keys may
   * be shared across deploys, so we must never evict a hash that some retained
   * deployment still references.
   *
   * The protection set is built from two sources: (1) all `retained=true`
   * deployments, and (2) the current live deployment (regardless of its
   * `retained` flag). Including (2) guards against the post-routing recovery
   * path where `markDeploymentRetained(...).catch(()=>{})` can silently fail,
   * leaving a deployment that is live but `retained=false`; without this
   * second source we would happily evict assets out from under real traffic.
   */
  const cleanupStreamedAssetsOnAbort = async (): Promise<void> => {
    // Drain first: a task still in flight may publish fresh entries to
    // `streamedHashStores` (and its claim) after we've computed the
    // retained-set. Without draining, those keys would escape eviction and
    // leak as orphan blobs. Draining before the size check also catches
    // the edge case where the pool had tasks pending but none had reached
    // `streamedHashStores.set(...)` yet.
    await drainInFlightStaticUploads();
    // Evict the WfP safety-net serving manifest regardless of whether any
    // blobs were streamed — the manifest is written even when all assets
    // were preflight-skipped (carry-forward serves them from the prior
    // mirror), and it is deployment-scoped so deletion is safe.
    if (wfpMirroredManifestDeploymentId) {
      const id = wfpMirroredManifestDeploymentId;
      wfpMirroredManifestDeploymentId = null;
      await c.env.ROUTING.delete(`manifest:${id}`).catch((err) =>
        console.warn(
          `[deploy] failed to evict mirrored manifest for aborted ${id}`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
    if (streamedHashStores.size === 0) {
      return;
    }
    try {
      const retainedHashes = new Set<string>();
      const collectFromAssetHashes = (raw: string | null): void => {
        if (!raw) {
          return;
        }
        try {
          const parsed = JSON.parse(raw) as Record<string, { hash?: string }>;
          for (const entry of Object.values(parsed)) {
            if (entry && typeof entry.hash === 'string') {
              retainedHashes.add(entry.hash);
            }
          }
        } catch {
          // ignore malformed manifests — be conservative and continue
        }
      };
      const hasForeignStreamedAssetClaim = async (hash: string): Promise<boolean> => {
        const foreignClaims = await c.env.ROUTING.list({
          prefix: `${STREAMED_ASSET_CLAIM_PREFIX}:${projectId}:${hash}:`,
        });
        return foreignClaims.keys.some(
          (key) => key.name !== streamedAssetClaimKey(projectId, hash, streamedAssetClaimToken),
        );
      };

      const retained = await getRetainedDeployments(c.get('db'), projectId);
      for (const dep of retained) {
        collectFromAssetHashes(dep.asset_hashes ?? null);
      }

      const inFlight = await getInFlightDeploymentsExcluding(
        c.get('db'),
        projectId,
        cleanupExcludeDeploymentId,
      );
      for (const dep of inFlight) {
        collectFromAssetHashes(dep.asset_hashes ?? null);
      }

      // Other concurrent streamed-static requests may already have hashed the
      // same content-addressed blob and published an in-flight claim, but not
      // yet persisted `asset_hashes` to their deployment row. Protect those
      // hashes too, while explicitly ignoring this request's own claim token
      // so abort cleanup still sweeps blobs that are only referenced by the
      // failing request itself.
      for (const hash of streamedHashStores.keys()) {
        if (await hasForeignStreamedAssetClaim(hash)) {
          retainedHashes.add(hash);
        }
      }

      // Also protect the current live deployment even if it is not in the
      // retained set. A live-but-not-retained deployment is possible after
      // a post-routing recovery where markDeploymentRetained failed silently
      // but routing is still pointed at the deployment, so its asset hashes
      // are still being served by traffic.
      const latestProject = await getProject(c.get('db'), projectId);
      if (latestProject?.active_deployment_id) {
        const inRetainedList = retained.some((d) => d.id === latestProject.active_deployment_id);
        if (!inRetainedList) {
          const active = await getDeployment(c.get('db'), latestProject.active_deployment_id);
          if (active) {
            collectFromAssetHashes(active.asset_hashes ?? null);
          }
        }
      }

      await cleanupStreamedStaticAssets(
        c.env.STATIC_ASSETS,
        c.env.STATIC_ASSETS_R2,
        projectId,
        streamedHashStores,
        retainedHashes,
        hasForeignStreamedAssetClaim,
      );
      // Only clear on a successful sweep. A re-entry via the outer catch
      // (triggered by a non-parser error re-thrown from the parse loop)
      // will then short-circuit via the early return above. On failure we
      // intentionally leave the map populated so the outer catch gets a
      // second best-effort sweep — cleanupStreamedStaticAssets is idempotent
      // against already-deleted keys, so re-running only pays for a wasted
      // retained-set query while preserving the chance to clean up blobs
      // left orphaned by a transient DB/KV/R2 failure on the first attempt.
      streamedHashStores.clear();
    } catch (err) {
      console.warn(
        `[deploy] streamed asset cleanup failed for project ${projectId}`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  // Validate the multipart boundary BEFORE opening the response stream. Once
  // the TransformStream is constructed and handed to `new Response(...)`, the
  // handler is committed to a 200 + NDJSON reply — errors become `{event:
  // 'error'}` lines instead of HTTP statuses. A missing / malformed
  // Content-Type is a pre-stream concern (it's a sync header read, not
  // something uncovered during body parse), so keep it on the 4xx path
  // alongside the other pre-stream guards (404 project, 403 forbidden,
  // 409 concurrent deploy). Monitoring tools and generic HTTP clients expect
  // malformed requests to carry a 4xx, not a 200-with-error-body.
  let multipartBoundary: string;
  try {
    multipartBoundary = parseBoundary(c.req.raw.headers.get('content-type'));
  } catch (err) {
    if (err instanceof MultipartParseError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  // Construct the response stream BEFORE parse/upload work so the client sees
  // headers immediately. Every byte emitted downstream (parse rejections,
  // heartbeats, deploy progress) flows through `writer`. The `return new
  // Response(readable, ...)` at the bottom of this handler executes before the
  // IIFE even begins its first await — CF edge / intermediaries get the 200
  // status line right away and hold the connection open for the body.
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let streamOpen = true;
  let currentStep = 'parsing';
  let currentDeploymentId = '';
  const emit = (event: DeployEvent): void => {
    if (!streamOpen) {
      return;
    }
    // WritableStreamDefaultWriter.write() reports errors via a rejected
    // promise, not a sync throw. When the downstream ReadableStream is
    // canceled (e.g. client disconnect), the returned promise rejects —
    // attach .catch() so we flip streamOpen and subsequent emits / the
    // heartbeat loop become cheap no-ops instead of leaking unhandled
    // rejections for the remainder of the pipeline.
    writer.write(encoder.encode(JSON.stringify(event) + '\n')).catch((err) => {
      streamOpen = false;
      console.warn(
        `[deploy] ${projectId}: deploy stream closed while emitting ${event.event}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });
  };
  // Heartbeat cadence is hard-coded in production (15s) but overridable via
  // `DEPLOY_HEARTBEAT_INTERVAL_MS` for integration tests that assert the timer
  // fires during parse/pipeline — 15s is too slow to run in a unit test. Any
  // non-positive / non-finite override falls back to the production default,
  // and a 1ms floor guards against runaway 0ms intervals.
  const heartbeatOverride = c.env.DEPLOY_HEARTBEAT_INTERVAL_MS;
  const heartbeatIntervalMs =
    typeof heartbeatOverride === 'number' &&
    Number.isFinite(heartbeatOverride) &&
    heartbeatOverride > 0
      ? Math.max(1, heartbeatOverride)
      : 15_000;

  void (async () => {
    let routingSwitched = false;
    let cronSynced = false;
    let manifest: DeployManifest | undefined;
    let workerName: string | undefined;
    let dispatchNamespace: string | undefined;
    let deployment: Awaited<ReturnType<typeof createDeployment>> | undefined;

    // Timer is created inside the IIFE so it is scope-paired with its
    // clearInterval in the finally below. If setup and teardown lived in
    // different scopes, any code later inserted between them (or a pre-stream
    // guard moved down) would leak the interval on a synchronous early return.
    const heartbeat = setInterval(() => {
      // Omit `deploymentId` from heartbeats emitted before createDeployment
      // populates it. Emitting `deploymentId: ''` during the parse/validate
      // phase (the exact window where the heartbeat matters most) would
      // leak a protocol-invalid empty id to monitoring tools and any
      // external consumer that correlates events by deployment id.
      emit(
        currentDeploymentId
          ? { event: 'heartbeat', deploymentId: currentDeploymentId, step: currentStep }
          : { event: 'heartbeat', step: currentStep },
      );
    }, heartbeatIntervalMs);

    try {
      try {
        for await (const part of parseMultipart(c.req.raw.body, multipartBoundary)) {
          if (deferredParseErrorMessage) {
            await discardPartBody(part.body);
            continue;
          }
          if (part.name === 'manifest') {
            if (manifestSeen) {
              deferredParseErrorMessage = 'duplicate manifest part';
              await discardPartBody(part.body);
              continue;
            }
            manifestRaw = await readPartText(part.body, 'manifest', MAX_MANIFEST_BYTES);
            let parsedManifest: unknown;
            try {
              parsedManifest = JSON.parse(manifestRaw);
            } catch (parseErr) {
              deferredParseErrorMessage =
                'invalid manifest JSON: ' +
                (parseErr instanceof Error ? parseErr.message : String(parseErr));
              continue;
            }
            const shapeError = validateManifestShape(parsedManifest);
            if (shapeError) {
              deferredParseErrorMessage = shapeError;
              continue;
            }
            incomingManifest = parsedManifest as DeployManifest;
            if (
              incomingManifest.version == null ||
              !SUPPORTED_MANIFEST_VERSIONS.includes(incomingManifest.version)
            ) {
              deferredParseErrorMessage =
                'Unsupported deploy manifest version. Please update void.';
              continue;
            }
            manifestSeen = true;
            streamedStaticAssets =
              incomingManifest.type === 'spa' || incomingManifest.type === 'static';

            // For streamed-static deploys we cannot defer the daily-cap check
            // until after the parse: `asset:*` parts are written to KV/R2 as
            // they arrive (see the concurrency-limited upload pool below), so
            // by the time the post-parse check fires an over-quota user has already
            // paid for every byte in storage write cost. Reject here, before
            // any asset part is streamed. This sacrifices dedupe-at-cap for
            // static retries, which is an acceptable tradeoff: the cap is
            // intended to be a hard ceiling and storage writes should not
            // happen past it. Worker-backed deploys still defer to the
            // post-dedupe check further down because their worker modules are
            // buffered in RAM, not persisted during parse.
            if (streamedStaticAssets && planLimits.deploysPerDay > 0) {
              const todayCount = await countUserDeploymentsToday(c.get('db'), c.get('user').id);
              if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
                deferredParseErrorMessage = 'deploy limit exceeded';
                continue;
              }
            }
            continue;
          }
          if (part.name === 'assetManifest') {
            incomingAssetManifestRaw = await readPartText(
              part.body,
              'assetManifest',
              MAX_ASSET_MANIFEST_BYTES,
            );
            // Parse eagerly so the `asset:*` fast-path below can detect
            // in-request duplicate hashes (common with CLIs that mirror the
            // same asset under multiple paths — e.g. a blog that emits every
            // media file both under `/client/blog/...` and `/blog/...`).
            // `parseAssetManifest` returns `null` on malformed/empty input
            // and never throws; the stricter shape validation still runs
            // post-parse at `applyDeclaredAssetManifest` time, so an invalid
            // declared manifest simply means the fast-path doesn't activate.
            declaredAssetManifest = parseAssetManifest(incomingAssetManifestRaw);
            continue;
          }
          if (part.name === 'source') {
            source = await readPartText(part.body, 'source', MAX_SMALL_TEXT_BYTES);
            continue;
          }
          if (part.name === 'commit') {
            commit = await readPartText(part.body, 'commit', MAX_SMALL_TEXT_BYTES);
            continue;
          }
          if (part.name === 'preflight') {
            preflightRaw = await readPartText(part.body, 'preflight', MAX_PREFLIGHT_BYTES);
            continue;
          }
          // `worker:*` and `asset:*` parts depend on the deploy mode decided by
          // the manifest. They MUST arrive after the manifest so we know whether
          // to buffer them (full deploy) or stream directly to KV/R2 (static).
          if (part.name.startsWith('worker:') || part.name.startsWith('asset:')) {
            if (!manifestSeen) {
              emit({
                event: 'error',
                message: 'manifest part must precede worker and asset parts',
                step: currentStep,
              });
              await cleanupStreamedAssetsOnAbort();
              await cleanupOwnStreamedAssetClaims();
              return;
            }
          }
          if (part.name.startsWith('worker:')) {
            // Static deploys have no worker script. Rejecting here avoids orphaned
            // streamed assets when a malformed payload mixes a static manifest with
            // worker parts.
            if (streamedStaticAssets) {
              deferredParseErrorMessage =
                'worker parts are not allowed when manifest.type is spa or static';
              await discardPartBody(part.body);
              continue;
            }
            hasWorkerFiles = true;
            const filePath = part.name.slice('worker:'.length);
            // Read the module body directly into a Blob inside `readPartAsBlob`.
            // This avoids naming a `Uint8Array` in this loop body — a local const
            // here can survive into the next iteration before V8 runs GC, which
            // is the exact path that can push the per-request peak over 128 MiB
            // when several large `worker:*` parts are back-to-back.
            workerFiles.push({
              name: filePath,
              content: await readPartAsBlob(
                part.body,
                `worker:${filePath}`,
                MAX_WORKER_FILE_BYTES,
                moduleContentType(filePath),
              ),
            });
            continue;
          }
          if (part.name.startsWith('asset:')) {
            const path = '/' + part.name.slice('asset:'.length);
            if (streamedStaticAssets) {
              // Fast-path: drain duplicate-hash bodies without buffering.
              //
              // Many CLIs (and some SSG frameworks like the cpojer-blog
              // build) emit the same binary under multiple URL paths —
              // a 19 MiB Git.mp4 appearing as both `/client/blog/.../Git.mp4`
              // and `/blog/.../Git.mp4` is typical. Under the full-read path
              // both parts allocate and hash 19 MiB each, even though
              // `uploadStaticAssetPart`'s dedupe #2 ultimately issues only
              // one KV/R2 PUT. Skipping the buffered read for duplicates
              // removes that redundant allocation entirely, keeping peak
              // memory proportional to unique content rather than part count.
              //
              // If the declared manifest maps `path` to a hash we are
              // already uploading (or have uploaded) in THIS request, we
              // already hold the verified bytes for that hash — the server
              // stores the first occurrence's fully-hashed content at
              // `assets/${projectId}/${declared.hash}`. We can drain this
              // duplicate's body with byte-count verification and commit
              // `builtAssetManifest[path] = { hash, size }` directly, with
              // no buffered allocation and no additional PUT.
              //
              // Security: dedupe is per-request, keyed by blobs this same
              // request already read-and-verified. A malicious client that
              // declares a wrong hash for a later path can only cause the
              // first-occurrence's content to serve at that later path —
              // which is exactly what the declared manifest asked for.
              // Cross-project bleed is blocked by the `projectId`-scoped
              // KV/R2 key namespace.
              //
              // Size verification: we still enforce `bytesSeen ===
              // declared.size` so a client cannot lie about size to
              // create an inconsistent manifest entry that would
              // mismatch the stored blob.
              //
              // One lookup + shape validation shared across both
              // declared-manifest branches below (fast-path and streaming):
              // the two have identical "client sent a well-formed
              // `{ hash, size }` for this path" invariant and only differ
              // by whether the hash is already resident this request and
              // whether the size crosses the streaming threshold. A single
              // validated reference keeps future changes to the
              // well-formed-ness rules in lockstep.
              const declaredEntry = declaredAssetManifest?.[path];
              const declared =
                declaredEntry != null &&
                typeof declaredEntry.hash === 'string' &&
                declaredEntry.hash.length === 32 &&
                Number.isFinite(declaredEntry.size) &&
                declaredEntry.size >= 0
                  ? declaredEntry
                  : null;
              if (
                declared &&
                (streamedHashStores.has(declared.hash) || inFlightUploadByHash.has(declared.hash))
              ) {
                // Stream-hash verify the body against the declared hash.
                // Byte-count-only drain would let a duplicate-path part with
                // corrupted or tampered bytes silently commit a manifest
                // entry pointing at the first occurrence's content —
                // `applyDeclaredAssetManifest` then sees matching declared
                // values and never revalidates, losing the end-to-end
                // integrity check the full-read path provides on the first
                // occurrence. Incremental hashing has constant memory cost
                // (hasher state + a ≤2 byte carry), so this preserves the
                // O(1)-residency property that makes the fast-path
                // worthwhile while restoring the mismatch detection.
                await verifyStreamedAssetPart(part.body, path, declared);
                builtAssetManifest[path] = {
                  hash: declared.hash,
                  size: declared.size,
                };
                // Publish our own claim for this hash so `cleanupOwnStreamedAssetClaims`
                // still has something to delete if the deploy fails later.
                // Idempotent via the sync `claimedStreamedHashes.has` guard.
                await ensureStreamedAssetClaim(declared.hash);
                continue;
              }
              // Direct-to-R2 streaming path: when the client declared a valid
              // `{ hash, size }` for this path AND the declared size crosses
              // the KV threshold, pipe `part.body` straight through a hashing
              // transform into `r2.put` without buffering the bytes. Per-asset
              // memory is O(1) (hasher state + ≤ 2-byte carry), so a single
              // large asset no longer pins its full size against the 128 MiB
              // request budget.
              //
              // Preconditions (all required — otherwise fall through to the
              // buffered pool path, which handles smaller files and recovers
              // from any declared-manifest anomalies the full read would catch):
              //   - `declaredAssetManifest` entry exists for this path
              //   - `declared.hash` is the right shape (32 hex chars)
              //   - `declared.size` is a sane, non-negative, cap-abiding integer
              //   - `declared.size >= KV_THRESHOLD` (smaller assets still go
              //     through KV via the pool path — KV PUTs are cheap and the
              //     small payload doesn't justify the streaming complexity)
              //   - the hash is NOT already handled this request (branch 1
              //     above owns the duplicate-hash case)
              //
              // Serialization: `streamStaticAssetToR2` drives `part.body` to
              // completion before returning, which means the multipart parser
              // is blocked for the duration. We MUST drain `inFlightStaticUploads`
              // first — otherwise a pool task could be mid-stream on a prior
              // `part.body`, racing the transport reader with our new pipe
              // reader. The pool size is bounded by `STATIC_ASSET_UPLOAD_CONCURRENCY`,
              // so this is a short wait on asset-heavy deploys. This path
              // never buffers asset bytes in Worker memory — O(1) residency
              // for an arbitrarily large asset.
              if (
                declared &&
                declared.size >= KV_THRESHOLD &&
                !streamedHashStores.has(declared.hash) &&
                !inFlightUploadByHash.has(declared.hash)
              ) {
                while (inFlightStaticUploads.size > 0) {
                  // Drain the KV/R2 pool before we start streaming: the pool
                  // tasks own the previous part's buffered read, but they
                  // don't necessarily contend for the transport reader once
                  // `readStaticAssetPart` returns. Still, running a stream
                  // pipe concurrently with an in-flight task that itself
                  // calls `onHashed` → `ROUTING.put` would race on KV order,
                  // and more importantly we want the streaming path to have
                  // uncontested access to the request body's reader during
                  // its single-threaded pipeThrough/pipeTo pair.
                  await Promise.race(inFlightStaticUploads);
                }
                // Register the hash for abort cleanup BEFORE `r2.put` can
                // succeed. `streamStaticAssetToR2` can throw *after* it has
                // already written bytes to R2 — specifically on the
                // hash-mismatch-after-write path, where its best-effort
                // `r2.delete` may transiently fail. If we waited to
                // populate `streamedHashStores` until after the call
                // returned, `cleanupStreamedAssetsOnAbort` would have no
                // record of this hash and the poisoned blob would linger
                // at `assets/${projectId}/${declared.hash}`. A later
                // deploy with correct bytes would then hit the
                // precondition-miss path (key exists) and trust the stored
                // bytes — serving corrupted content.
                //
                // Pre-registering is safe on every other outcome:
                //   - Happy path: no abort runs, the map is discarded at
                //     request end.
                //   - Early throw (FixedLengthStream size mismatch before
                //     the put completes): cleanup tries to delete a key
                //     that was never written → R2 delete is a no-op.
                //   - Precondition miss (result === null): the existing
                //     blob was written by another deploy. That deploy's
                //     claim and/or its retained deployment row mark the
                //     hash as foreign, so `cleanupStreamedAssetsOnAbort`
                //     protects it via `hasForeignStreamedAssetClaim` /
                //     `retainedHashes` — our registration does not cause
                //     a cross-deploy wipe.
                //
                // Claim publishing (`ensureStreamedAssetClaim`) moves up
                // for the same reason: a late claim write after the put
                // succeeded would miss an abort-cleanup window. It's
                // idempotent via `claimedStreamedHashes.has`, so the
                // pre-put call is cheap.
                streamedHashStores.set(declared.hash, 'r2');
                streamedLargeHashes.add(declared.hash);
                await ensureStreamedAssetClaim(declared.hash);

                const { isNew } = await streamStaticAssetToR2(
                  c.env.STATIC_ASSETS_R2,
                  projectId,
                  path,
                  part.body,
                  declared,
                  getContentType(path),
                );
                // Parse-order deterministic, synchronous writes: same shape
                // as both the fast-path (branch 1) and the pool path commit
                // (branch 3). Last multipart-part wins if a path repeats.
                builtAssetManifest[path] = {
                  hash: declared.hash,
                  size: declared.size,
                };
                if (isNew) {
                  newStaticAssetCount++;
                }
                continue;
              }
              // Gate BEFORE reading the part body. Waiting here caps peak
              // pool concurrency at `STATIC_ASSET_UPLOAD_CONCURRENCY` (the
              // currently-reading task slots into a freed spot), serving
              // as reader-safety backpressure: a burst of tiny assets
              // can't schedule hundreds of PUTs whose retries would stall
              // the runtime.
              //
              // Promise.race resolves when any upload settles, and that
              // promise's `.finally` removes it from the set *before*
              // settling its derived promise, so the while-condition
              // observes the new size on the next iteration.
              while (inFlightStaticUploads.size >= STATIC_ASSET_UPLOAD_CONCURRENCY) {
                await Promise.race(inFlightStaticUploads);
              }
              const prepared = await readStaticAssetPart(part.body, path);
              // Commit the manifest entry synchronously in parse order.
              // `uploadStaticAssetPart` returns `entry = { hash, size }`
              // in every dedupe branch — values we already have from
              // `prepared` — so deferring this write into the upload
              // task's async body would make last-writer-wins depend on
              // KV/R2 completion order, not multipart parse order. For
              // a payload that repeats the same asset path, that split
              // would let a slower earlier upload overwrite a faster
              // later upload and silently flip the deployed content (or
              // trip `AssetHashMismatchError` against the declared
              // manifest). Writing here mirrors the old sequential
              // behaviour: whichever part appears last in the multipart
              // stream wins the path deterministically.
              builtAssetManifest[path] = { hash: prepared.hash, size: prepared.size };
              const uploadTask = (async () => {
                const { store, isNew } = await uploadStaticAssetPart(
                  c.env.STATIC_ASSETS,
                  c.env.STATIC_ASSETS_R2,
                  projectId,
                  prepared,
                  streamedHashStores,
                  inFlightUploadByHash,
                  { onHashed: ensureStreamedAssetClaim },
                );
                if (store === 'r2') {
                  streamedLargeHashes.add(prepared.hash);
                }
                if (isNew) {
                  newStaticAssetCount++;
                }
              })();
              inFlightStaticUploads.add(uploadTask);
              // Retain a reference in `staticUploadPromises` so a rejection
              // that settles before the post-parse drain is still surfaced —
              // if we relied on `inFlightStaticUploads` alone, early
              // rejections would be removed from the set by their `.finally`
              // deletion before `Promise.all` ran, and the error would be
              // silently lost.
              staticUploadPromises.push(uploadTask);
              uploadTask
                .finally(() => {
                  inFlightStaticUploads.delete(uploadTask);
                })
                .catch(() => {
                  // Suppress unhandled-rejection warning: the rejection is
                  // re-surfaced via `await Promise.all(staticUploadPromises)`
                  // after the parse loop.
                });
            } else {
              const { entry, hash, assetEntry } = await collectBufferedAsset(path, part.body);
              builtAssetManifest[path] = entry;
              // Duplicate content hashes collapse to one live buffered blob
              // in `assetsByHash` — the replaced entry is unreachable and
              // becomes GC-eligible.
              assetsByHash.set(hash, assetEntry);
            }
            continue;
          }
          // Unknown part (e.g. legacy `migration:*`) — the parser auto-drains it
          // when we don't consume its body.
        }
        // Drain the streamed-static upload pool before post-parse validation:
        // `builtAssetManifest`, `streamedHashStores`, `streamedLargeHashes`,
        // and `newStaticAssetCount` are all written from inside the pool
        // tasks, so any code that reads them (dedupe compare,
        // cleanup-on-abort, the final asset-count event) must see a
        // fully-settled state. `Promise.all` re-surfaces the first upload
        // rejection here, inside the parse `try`, so the existing `catch`
        // below routes it through the same cleanup path as a parse error.
        if (staticUploadPromises.length > 0) {
          await Promise.all(staticUploadPromises);
        }
        if (deferredParseErrorMessage) {
          await cleanupStreamedAssetsOnAbort();
          await cleanupOwnStreamedAssetClaims();
          emit({ event: 'error', message: deferredParseErrorMessage, step: currentStep });
          return;
        }
      } catch (err) {
        // Both cleanup helpers drain `inFlightStaticUploads` internally
        // before touching KV/R2 or ROUTING, so a late-settling PUT cannot
        // resurrect a key or claim we just deleted. Call them in order —
        // claim-delete must follow the PUT whose `onHashed` wrote it,
        // which the shared drain guarantees.
        await cleanupStreamedAssetsOnAbort();
        await cleanupOwnStreamedAssetClaims();
        if (
          err instanceof MultipartParseError ||
          err instanceof PartTooLargeError ||
          err instanceof AssetHashMismatchError
        ) {
          // `AssetHashMismatchError` reaches here from `verifyStreamedAssetPart`
          // in the duplicate-hash fast-path. Treat it as a parse-time client
          // error (same as size/shape mismatches) so the NDJSON event carries
          // `step: 'parsing'` rather than the misleading later step it would
          // land on if it bubbled to the outer catch.
          emit({ event: 'error', message: err.message, step: currentStep });
          return;
        }
        throw err;
      }

      // === POST-PARSE VALIDATION ===
      currentStep = 'validating';
      // Reuse the eagerly-parsed manifest from the `assetManifest` part
      // handler above — same input string, never mutated during parse, and
      // the declared manifest can be up to `MAX_ASSET_MANIFEST_BYTES` (32 MiB)
      // so a second `JSON.parse` would duplicate both the CPU cost and the
      // parsed-object heap footprint.
      const incomingAssetManifest = declaredAssetManifest;

      // Guard against a body that parsed cleanly but never included a manifest
      // part. A missing manifest must not fall through to the deploy pipeline
      // (where an empty default would silently create a blank live deployment).
      if (!manifestSeen || incomingManifest == null) {
        await cleanupStreamedAssetsOnAbort();
        await cleanupOwnStreamedAssetClaims();
        emit({ event: 'error', message: 'manifest part is required', step: currentStep });
        return;
      }

      const enrichedManifestResult = enrichWebSocketManifest(
        incomingManifest,
        parseManifest(currentLiveDeployment?.manifest),
        project.websocket_version,
      );
      manifest = enrichedManifestResult.manifest;
      const finalManifestRaw = JSON.stringify(manifest);
      const comparableAssetManifest = await buildComparableAssetManifestForDedupe(
        c.get('db'),
        projectId,
        builtAssetManifest,
        incomingAssetManifest,
        preflightRaw,
      );

      // Skip static-only deploys if identical to the current live deployment.
      // Worker-backed deploys are not skipped because the deploy manifest does not
      // include worker module content hashes.
      // Secrets are not checked: the secrets API already live-pushes values to the active
      // worker via putWorkerSecret.
      if (!hasWorkerFiles && currentLiveDeployment && currentLiveDeployment.status === 'live') {
        const sameManifest = currentLiveDeployment.manifest === finalManifestRaw;
        const sameAssets = equalAssetManifests(
          comparableAssetManifest,
          parseAssetManifest(currentLiveDeployment.asset_hashes),
        );
        if (sameManifest && sameAssets) {
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          const projectDomains = await getDomainsByProjectId(c.get('db'), projectId);
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
          // Dedupe short-circuit: sweep anything the client streamed that is
          // NOT referenced by the matched live deployment. Hashes that are part
          // of the matched manifest are in the retained-hash set and will be
          // preserved by deleteUnreferencedAssets.
          await cleanupStreamedAssetsOnAbort();
          await cleanupOwnStreamedAssetClaims();
          return;
        }
      }

      // Daily deploy-count limit for worker-backed deploys. Runs AFTER the
      // dedupe branch so an identical retry at the cap is still served from
      // the live deployment instead of failing hard with 429. Worker parts
      // are buffered in RAM during parse (not persisted), so deferring the
      // check here costs nothing in storage writes. Streamed-static deploys
      // are gated earlier, at manifest-parse time, because they start writing
      // to KV/R2 during the parse loop — see the early check in the parse
      // loop above.
      if (!streamedStaticAssets && planLimits.deploysPerDay > 0) {
        const todayCount = await countUserDeploymentsToday(c.get('db'), c.get('user').id);
        if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
          await cleanupStreamedAssetsOnAbort();
          await cleanupOwnStreamedAssetClaims();
          emit({ event: 'error', message: 'deploy limit exceeded', step: currentStep });
          return;
        }
      }

      // Create deployment record
      deployment = await createDeployment(c.get('db'), projectId, finalManifestRaw, source, commit);
      currentDeploymentId = deployment.id;
      cleanupExcludeDeploymentId = deployment.id;
      if (enrichedManifestResult.changed) {
        await updateProjectWebSocketVersion(
          c.get('db'),
          projectId,
          enrichedManifestResult.nextVersion,
        );
      }
      dispatchNamespace = c.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      workerName = `user-${project.slug}-${deployment.id}`;

      // Re-bind as const with non-null narrowing so references inside nested
      // async callbacks (retryWithBackoff, uploadPool, ...) keep their typing.
      // The outer `let` bindings above were just assigned and are guaranteed
      // defined here, but TS loses `let` narrowing inside async closures
      // (they could be reassigned externally). The outer `let` bindings are
      // still what the outer catch reads to detect a pre-createDeployment
      // failure.
      const pipelineDeployment = deployment;
      const pipelineManifest = manifest;
      const pipelineWorkerName = workerName;
      const pipelineDispatchNamespace = dispatchNamespace;

      try {
        // Shadow with the original names so the pipeline body (unchanged)
        // binds to these consts.
        const deployment = pipelineDeployment;
        const manifest = pipelineManifest;
        const workerName = pipelineWorkerName;
        const dispatchNamespace = pipelineDispatchNamespace;

        emit({ event: 'start', deploymentId: deployment.id });

        // === ASSET UPLOAD PHASE ===
        currentStep = 'asset_upload';
        await updateDeploymentStatus(c.get('db'), deployment.id, 'uploading');
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);

        // Merge the declared asset manifest into the one we built from the
        // streamed parts — this validates hash agreement and preserves the
        // CLI-declared `size` field verbatim when it matches.
        const assetManifest = applyDeclaredAssetManifest(
          builtAssetManifest,
          incomingAssetManifest ?? undefined,
        );
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);

        // When preflight was used, fill in skipped assets.
        // Prefer the CLI's full manifest (new CLIs send it) to avoid accumulating
        // stale entries from previous deploys. Fall back to the previous deploy's
        // manifest for older CLIs that don't send it.
        const preflightUsed = preflightRaw === 'true';
        if (preflightUsed) {
          const fillManifest =
            incomingAssetManifest ?? (await getLastLiveAssetManifest(c.get('db'), projectId));
          if (fillManifest) {
            for (const [path, entry] of Object.entries(fillManifest)) {
              if (!(path in assetManifest)) {
                assetManifest[path] = entry;
              }
            }
          }
        }

        // Determine if this is a static-only deploy (no worker files in FormData)
        const isStaticOnly = !hasWorkerFiles;

        // CF's `assets-upload-session` API can return empty/incomplete buckets
        // when its dedupe index is in a bad state for some hashes — entries get
        // claimed in the index without actual bytes backing them, then later
        // requests serve a 36-byte "Assets have not yet been deployed..." stub.
        // Tracked in cloudflare/workers-sdk#12586 (CF internal WC-4511).
        // Workaround: inject a deterministic-but-unique-per-deploy asset so the
        // session always sees at least one novel hash, forcing CF to re-validate
        // the full manifest. Only needed for the WfP path; static-only deploys
        // upload directly to KV/R2 and don't hit this API.
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

        // Fetch domains once — used in both static-only and full deploy paths
        const projectDomains = await getDomainsByProjectId(c.get('db'), projectId);

        if (isStaticOnly) {
          // Static-only deploy: upload assets to KV/R2, skip bindings/migrations/WfP
          currentStep = 'asset_upload';
          const assetConfig = manifest.assetConfig ?? {
            not_found_handling: 'single-page-application',
          };

          // For streamed static deploys, assets were already piped into KV/R2
          // during body parsing — just reuse the set of R2-stored hashes.
          // For buffered static deploys (older CLIs without manifest.type),
          // upload from the assetsByHash map as before.
          const newAssets = streamedStaticAssets ? newStaticAssetCount : assetsByHash.size;
          emit({
            event: 'asset_upload',
            total: assetCount,
            new: newAssets,
            cached: assetCount - newAssets,
          });
          const largeHashes = streamedStaticAssets
            ? streamedLargeHashes
            : await uploadStaticAssets(
                c.env.STATIC_ASSETS,
                c.env.STATIC_ASSETS_R2,
                assetsByHash,
                projectId,
              );
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          emit({ event: 'asset_upload_done' });

          // Build serving manifest: path → hash (prefix with "!" for R2-stored assets)
          // For assets from preflight (not in assetsByHash), carry forward R2 status
          // from the previous deployment's manifest
          let prevServingManifest: Record<string, string> | null = null;
          if (preflightUsed && project.active_deployment_id) {
            const prev = await c.env.ROUTING.get(`manifest:${project.active_deployment_id}`);
            if (prev) {
              prevServingManifest = JSON.parse(prev) as Record<string, string>;
            }
          }

          // Build a reverse lookup from hash → "!" prefix status from previous manifest
          const prevR2Hashes = new Set<string>();
          if (prevServingManifest) {
            for (const v of Object.values(prevServingManifest)) {
              if (v.startsWith('!')) {
                prevR2Hashes.add(v.slice(1));
              }
            }
          }

          const servingManifest: Record<string, string> = {};
          for (const [path, entry] of Object.entries(assetManifest)) {
            if (largeHashes.has(entry.hash)) {
              // Newly uploaded to R2
              servingManifest[path] = `!${entry.hash}`;
            } else if (prevR2Hashes.has(entry.hash)) {
              // Preflight-skipped asset that was previously in R2
              servingManifest[path] = `!${entry.hash}`;
            } else {
              // KV-stored asset (newly uploaded or preflight-skipped)
              servingManifest[path] = entry.hash;
            }
          }

          // Store serving manifest in ROUTING KV for dispatch to look up
          await c.env.ROUTING.put(`manifest:${deployment.id}`, JSON.stringify(servingManifest));

          // Store asset manifest in DB for future preflight dedup + retention cleanup.
          // The retention claim below (markDeploymentRetained) is what actually
          // guarantees these hashes are visible to future cleanup — until then
          // `getRetainedDeployments` filters on `retained=true` and wouldn't
          // see this deployment, so a failure between here and the retention
          // claim must still sweep the streamed blobs.
          await c
            .get('db')
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));

          // Use manifest type when present, fall back to assetConfig-based derivation for older CLIs
          const type =
            manifest.type ??
            (assetConfig.not_found_handling === 'single-page-application' ? 'spa' : 'static');

          // Set KV routing — uses staticDeploymentId (no WfP worker)
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
          await c.env.ROUTING.put(project.slug, routingJson);
          routingSwitched = true;

          for (const domain of projectDomains) {
            if (domain.status === 'active') {
              await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
            }
          }

          // Mark deployment live + update project type
          await updateDeploymentStatus(c.get('db'), deployment.id, 'live', undefined, {
            force: true,
          });
          await updateProjectType(c.get('db'), projectId, type);
          await setActiveDeployment(c.get('db'), projectId, deployment.id);
          await markDeploymentRetained(c.get('db'), deployment.id, true);

          // Hard cutoff: delete legacy WfP scripts (one-time cleanup on first KV/R2 deploy)
          const legacyName = `user-${project.slug}`;
          await deleteDispatchScript(
            c.env.CF_ACCOUNT_ID,
            c.env.CF_API_TOKEN,
            dispatchNamespace,
            legacyName,
          );

          // Fetch all retained deployments once — used for both WfP cleanup and retention
          const retained = await getRetainedDeploymentsExcluding(
            c.get('db'),
            projectId,
            deployment.id,
          );

          // Delete any previously retained versioned WfP scripts
          for (const old of retained) {
            await deleteDispatchScript(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              dispatchNamespace,
              `user-${project.slug}-${old.id}`,
            );
          }

          // Static retention cleanup — STATIC_RETENTION_LIMIT (100) instead of per-plan limits
          if (STATIC_RETENTION_LIMIT > 0) {
            // STATIC_RETENTION_LIMIT includes the active deployment, so keep (limit - 1) others
            const toEvict = retained.slice(STATIC_RETENTION_LIMIT - 1);
            if (toEvict.length > 0) {
              // Collect all hashes from the current + remaining retained deployments
              const retainedHashes = new Set<string>();
              for (const [, entry] of Object.entries(assetManifest)) {
                retainedHashes.add(entry.hash);
              }
              const keptDeployments = retained.slice(0, STATIC_RETENTION_LIMIT - 1);
              for (const kept of keptDeployments) {
                if (kept.asset_hashes) {
                  const keptManifest = JSON.parse(kept.asset_hashes) as Record<
                    string,
                    { hash: string }
                  >;
                  for (const entry of Object.values(keptManifest)) {
                    retainedHashes.add(entry.hash);
                  }
                }
              }

              for (const old of toEvict) {
                // Collect evicted hashes and delete unreferenced assets
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
                // Delete serving manifest from ROUTING KV
                await c.env.ROUTING.delete(`manifest:${old.id}`);
                await markDeploymentRetained(c.get('db'), old.id, false);
              }
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

        // Full deploy path
        // Provision bindings (D1, KV, R2) — creates CF resources if needed
        currentStep = 'provisioning';

        // Derive binding labels from the manifest upfront so we can show the
        // spinner BEFORE the (potentially slow) CF API provisioning calls.
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

        // Upload assets via CF asset upload API (3-step flow)
        let completionJwt: string | undefined;
        if (assetCount > 0) {
          currentStep = 'asset_upload';
          const newAssets = assetsByHash.size;
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
            assetManifest,
          );
          console.log(
            `[deploy] ${projectId}: asset session created, ${Object.keys(assetManifest).length} manifest entries, ${session.buckets.length} bucket(s), ${assetsByHash.size} blobs available`,
          );

          // Upload asset buckets to CF. When all assets are cached (empty buckets),
          // the session JWT is already the completion token — no exchange needed.
          completionJwt = await uploadAssetBuckets(
            c.env.CF_ACCOUNT_ID,
            session.jwt,
            session.buckets,
            assetsByHash,
          );
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          console.log(
            `[deploy] ${projectId}: asset upload complete, got completion JWT: ${completionJwt ? 'yes' : 'no'}`,
          );
          emit({ event: 'asset_upload_done' });

          // Persist the asset manifest as soon as CF acknowledges the bytes.
          // Writing this here — before worker upload, migrations, retention,
          // and routing — means any later-step failure (migrations especially)
          // still leaves a row the next deploy's corroboration can read. This
          // is the minimal fix for the "first deploy fails at migration →
          // project permanently deadlocked" class of incident.
          await c
            .get('db')
            .update(deployments)
            .set({ asset_hashes: JSON.stringify(assetManifest) })
            .where(eq(deployments.id, deployment.id));

          // Mirror assets to platform R2/KV as a safety net for CF asset
          // dedupe poisoning (cloudflare/workers-sdk#12586). CF remains the
          // primary serving path; dispatch consults this mirror only when
          // CF returns the "Assets have not yet been deployed" stub. See
          // meta/design-docs/0066.
          //
          // Register hashes with the abort-cleanup path BEFORE the upload
          // so a partial failure — uploadStaticAssets runs concurrent
          // workers and rejects on the first error, leaving already-settled
          // writes on disk — still gets swept. Placement is a pure function
          // of size, so we compute it up-front instead of relying on the
          // return value (which is unreachable on rejection).
          for (const [hash, entry] of assetsByHash) {
            if (!streamedHashStores.has(hash)) {
              streamedHashStores.set(hash, entry.bytes.byteLength >= KV_THRESHOLD ? 'r2' : 'kv');
            }
          }

          const largeHashes = await uploadStaticAssets(
            c.env.STATIC_ASSETS,
            c.env.STATIC_ASSETS_R2,
            assetsByHash,
            projectId,
          );

          let prevServingManifest: Record<string, string> | null = null;
          if (preflightUsed && project.active_deployment_id) {
            const prev = await c.env.ROUTING.get(`manifest:${project.active_deployment_id}`);
            if (prev) {
              prevServingManifest = JSON.parse(prev) as Record<string, string>;
            }
          }

          // Hash → prior serving-manifest entry, so preflight-skipped assets
          // keep their R2-vs-KV placement without needing the bytes on hand.
          const prevHashEntry = new Map<string, string>();
          if (prevServingManifest) {
            for (const v of Object.values(prevServingManifest)) {
              const hash = v.startsWith('!') ? v.slice(1) : v;
              prevHashEntry.set(hash, v);
            }
          }

          const servingManifest: Record<string, string> = {};
          for (const [path, entry] of Object.entries(assetManifest)) {
            if (assetsByHash.has(entry.hash)) {
              servingManifest[path] = largeHashes.has(entry.hash) ? `!${entry.hash}` : entry.hash;
            } else if (prevHashEntry.has(entry.hash)) {
              // Preflight-skipped but the previous mirror has the bytes.
              servingManifest[path] = prevHashEntry.get(entry.hash)!;
            }
            // else: preflight-skipped with no prior mirror — bytes only live
            // in CF's asset store. Omit from serving manifest; fallback
            // cannot cover this path until a future deploy re-uploads it.
          }

          await c.env.ROUTING.put(`manifest:${deployment.id}`, JSON.stringify(servingManifest));
          wfpMirroredManifestDeploymentId = deployment.id;
        }

        // 1. Upload worker to dispatch namespace via CF API
        currentStep = 'worker_upload';
        const workerFormData = new FormData();

        // Worker modules were already buffered during the streaming body parse.
        emit({ event: 'worker_upload', modules: workerFiles.length });

        // Build combined bindings: user vars + provisioned (d1/kv/r2) + ASSETS
        // Platform bindings come LAST so they win on name collision (CF uses last-wins semantics)
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
          console.warn(
            `[deploy] manifest vars collide with project secrets (secrets win): ${collisions.join(', ')}`,
          );
        }

        const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
          type: 'plain_text' as const,
          name,
          text,
        }));
        const websocketBindings = buildWebSocketUploadBindings(manifest.websocket);
        const allBindings = [
          ...plainTextBindings,
          ...secretBindings,
          ...workerBindings,
          ...websocketBindings,
          ...(completionJwt ? [{ name: 'ASSETS', type: 'assets' }] : []),
        ];

        // Add metadata part (include provisioned bindings + assets)
        if (!manifest.compatibilityDate) {
          console.warn(
            `[deploy] manifest missing compatibilityDate for project ${project.id}, using fallback`,
          );
        }

        const assetConfig = manifest.assetConfig ?? { not_found_handling: 'none' };
        const websocketMigrations = buildWebSocketUploadMigrations(manifest.websocket?.migrations);
        const metadata: Record<string, unknown> = {
          main_module: manifest.workerMain ?? 'index.js',
          compatibility_date: manifest.compatibilityDate ?? '2026-02-12',
          compatibility_flags: manifest.compatibilityFlags ?? ['nodejs_compat'],
          bindings: allBindings,
          ...(websocketMigrations ? { migrations: websocketMigrations } : {}),
          ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
          observability: {
            enabled: true,
            logs: { invocation_logs: true, head_sampling_rate: 1 },
          },
        };
        workerFormData.append(
          'metadata',
          new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
        );

        // Add each worker module. The Blob was constructed at parse time
        // with the correct module content type, so we can append the
        // existing Blob directly instead of allocating a second copy here.
        for (const file of workerFiles) {
          workerFormData.append(file.name, file.content, file.name);
        }

        // Upload to CF Workers for Platforms API.
        // CF's WfP API sometimes returns plain text (e.g. "Assets have already
        // been uploaded") with 200 status instead of completing the upload.
        // This is the same CF bug handled in createAssetUploadSession — retry
        // to hit a different edge node.
        const workerUploadUrl = `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`;
        await retryWithBackoff(
          async () => {
            const cfResponse = await fetch(workerUploadUrl, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` },
              body: workerFormData,
            });

            if (!cfResponse.ok) {
              const error = await cfResponse.text();
              console.error(
                `[deploy] ${projectId}: worker upload failed (${cfResponse.status}): ${error.slice(0, 500)}`,
              );
              throw new Error(`worker upload failed: ${error}`);
            }

            const cfBody = await cfResponse.text();
            if (isCfAssetPlainText(cfBody)) {
              console.warn(
                `[deploy] ${projectId}: worker upload got CF plain-text response, retrying: ${cfBody.slice(0, 100)}`,
              );
              return undefined; // retry
            }
            return true;
          },
          {
            ...CF_RETRY,
            errorMessage: 'worker upload returned an unexpected Cloudflare response',
          },
        );
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);

        emit({ event: 'worker_upload_done' });

        // 1b. Run migrations via the newly-uploaded worker (v3 flow).
        // On failure, the thrown error propagates to the outer catch which
        // runs the pre-routing cleanup branch (`routingSwitched === false`)
        // and deletes the freshly-uploaded worker exactly once.
        let migrationsApplied = 0;
        if (manifest.migrations && manifest.migrations.pending > 0) {
          currentStep = 'migration';
          await updateDeploymentStatus(c.get('db'), deployment.id, 'migrating');
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          emit({ event: 'migration_start', pending: manifest.migrations.pending });

          const proxyTokenBinding = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN');

          // Worker name is unique per deployment, so the probe always targets the new script.
          // Returns "ready" when the endpoint confirms, or "compat" when the worker
          // is live but doesn't expose /__void/ready (older framework version).
          const probeResult = await retryWithBackoff<'ready' | 'compat'>(
            async () => {
              try {
                const userWorker = c.env.DISPATCH.get(workerName);
                const readyResponse = await userWorker.fetch(
                  new Request('https://internal/__void/ready', {
                    signal: AbortSignal.timeout(10_000),
                  }),
                );
                const text = await readyResponse.text();
                if (isCfAssetPlainText(text)) {
                  console.warn(
                    `[deploy] ${projectId}: readiness probe returned CF plain text: ${text}`,
                  );
                  return undefined; // retry
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
                  // Worker is live but doesn't expose /__void/ready (older framework version).
                  return 'compat';
                }
                if (readyResponse.ok) {
                  // 2xx but not { ready: true } — likely CF propagation lag
                  console.warn(
                    `[deploy] ${projectId}: readiness probe returned non-JSON 2xx, retrying: ${text.slice(0, 200)}`,
                  );
                  return undefined;
                }
                console.warn(
                  `[deploy] ${projectId}: readiness probe returned ${readyResponse.status}, retrying`,
                );
                return undefined;
              } catch (err) {
                console.warn(
                  `[deploy] ${projectId}: readiness probe threw: ${err instanceof Error ? err.message : err}`,
                );
                return undefined; // retry on timeout / network errors
              }
            },
            {
              ...CF_READINESS_RETRY,
              errorMessage: 'worker readiness probe failed: new worker not reachable after retries',
            },
          );

          // When the probe confirmed readiness, migration only needs short retries
          // for transient failures. When the probe was skipped (compat), migration
          // must absorb CF propagation lag itself — use the longer window.
          const migrationRetry = probeResult === 'ready' ? CF_MIGRATION_RETRY : CF_READINESS_RETRY;

          // Dispatch migration
          type MigrationResult = {
            ok: boolean;
            migrations: Array<{
              name: string;
              applied: boolean;
              durationMs: number;
              error?: string;
            }>;
            error?: string;
          };
          const result = await retryWithBackoff<MigrationResult>(
            async () => {
              const userWorker = c.env.DISPATCH.get(workerName);
              const migrateResponse = await userWorker.fetch(
                new Request('https://internal/__void/migrate', {
                  method: 'POST',
                  headers: { 'x-void-internal': proxyTokenBinding?.text ?? '' },
                  signal: AbortSignal.timeout(300_000),
                }),
              );

              const text = await migrateResponse.text();
              // CF dispatch can regress between consecutive calls; re-check
              if (isCfAssetPlainText(text)) {
                console.warn(`[deploy] migration dispatch returned CF plain text: ${text}`);
                return undefined; // retry
              }

              try {
                return JSON.parse(text) as MigrationResult;
              } catch {
                if (migrateResponse.ok) {
                  console.warn(
                    `[deploy] migration returned non-JSON 2xx, retrying: ${text.slice(0, 500)}`,
                  );
                  return undefined; // retry
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
            throw new Error(`migration failed: ${result.error ?? 'unknown error'}`);
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
        }

        // 2b. Configure queue consumers (dispatch worker relays to user workers)
        currentStep = 'queue_setup';
        const queueNames = (manifest.queues ?? []).map((q) => q.name);
        if (queueNames.length > 0) {
          emit({ event: 'queue_setup', queues: queueNames });
        }

        const dispatchWorkerName = c.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
        const queueProxyToken = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text;
        const queueConflicts: Array<{ queue: string; ownerScript: string }> = [];
        // Pass 1: register consumer subscriptions at CF and collect any
        // conflicts. Do NOT touch ROUTING KV yet — if a sibling queue
        // conflicts we throw, and the live KV route for every other queue
        // must stay pointing at the previously-live worker. Otherwise a
        // failed deploy would flip routing to a worker we are about to
        // tear down in the error cleanup.
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
        // Pass 2: flip KV routes only after we know every queue is claimable
        // by this deployment. proxyToken is included so void-dispatch can
        // set `x-void-internal` on the relay; without it the user worker's
        // framework-generated /__void/queue handler rejects with 401 and
        // messages silently exhaust retries.
        for (const outcome of consumerOutcomes) {
          if (!outcome) {
            continue;
          }
          await c.env.ROUTING.put(
            `queue:${outcome.queueBinding.queue_name}`,
            JSON.stringify({
              workerName,
              projectId,
              queueName: outcome.q.name,
              proxyToken: queueProxyToken,
            }),
          );
        }
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);

        // 2c. Sync cron schedules to CronScheduler DO
        currentStep = 'cron_setup';
        const hasCrons = manifest.schedules && manifest.schedules.length > 0;

        if (hasCrons) {
          const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
          const cronProxyToken = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text;
          await c.env.CRON_SCHEDULER.get(cronId).fetch(
            new Request('https://do/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                workerName,
                schedules: manifest.schedules,
                proxyToken: cronProxyToken,
              }),
            }),
          );
          cronSynced = true;
        } else {
          // Only clear if previous deploy had crons (avoid creating empty DOs)
          const prevRouting = await c.env.ROUTING.get(project.slug);
          if (prevRouting && JSON.parse(prevRouting).hasCrons) {
            const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
            await c.env.CRON_SCHEDULER.get(cronId).fetch(
              new Request('https://do/clear', { method: 'POST' }),
            );
          }
        }
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);

        // 3. Clear this deployment's ISR namespace before warming it.
        // ISR keys are deployment-scoped so a new deployment never reads HTML
        // produced by an older deployment with different hashed assets.
        await clearIsrCache(c.env.ISR_CACHE, projectId, deployment.id);
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);

        // 3b. Prerender pages (write ISR cache entries before going live)
        currentStep = 'prerender';
        if (manifest.prerender && manifest.prerender.length > 0 && manifest.revalidate) {
          emit({ event: 'prerender', pages: manifest.prerender.length });
          await updateDeploymentStatus(c.get('db'), deployment.id, 'prerendering');
          await assertDeploymentNotCanceled(c.get('db'), deployment.id);
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;

          await uploadPool(manifest.prerender, 3, async (pathname) => {
            const ttl = resolvePathTtl(manifest.revalidate, pathname);
            if (ttl <= 0) {
              return;
            }

            try {
              // Invoke the user worker directly via dispatch namespace
              const userWorker = c.env.DISPATCH.get(workerName);
              const url = `https://${project.slug}.${siteDomain}${pathname}`;
              const response = await userWorker.fetch(new Request(url));

              if (response.ok) {
                const key = isrCacheKey(projectId, deployment.id, pathname);
                const headers = serializePrerenderHeaders(response);
                const body = await response.arrayBuffer();
                const packed = packIsrValue(headers, body);

                await c.env.ISR_CACHE.put(key, packed, {
                  metadata: {
                    s: response.status,
                    c: Date.now(),
                    t: ttl,
                  },
                });
              }
            } catch {
              // Prerender failures are non-blocking — page will be rendered on first request
            }
          });
          emit({ event: 'prerender_done' });
        }
        await assertDeploymentNotCanceled(c.get('db'), deployment.id);

        // 4. Update KV routing table
        // Carry forward suspended flag from current KV entry
        const existingRouting = await c.env.ROUTING.get(project.slug);
        const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
        // Include per-request limits for dispatch enforcement
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
        await c.env.ROUTING.put(project.slug, routingJson);

        // Traffic can now reach the new worker via project.slug.
        // Set the flag immediately so the outer catch never deletes a live worker.
        routingSwitched = true;

        // Update KV routing for active custom domains
        for (const domain of projectDomains) {
          if (domain.status === 'active') {
            await c.env.ROUTING.put(`domain:${domain.hostname}`, routingJson);
          }
        }

        // 5. Mark deployment as live + update project mode
        await updateDeploymentStatus(c.get('db'), deployment.id, 'live', undefined, {
          force: true,
        });
        await updateProjectType(
          c.get('db'),
          projectId,
          manifest.type ?? (manifest.framework ? 'framework' : 'void'),
        );

        // 5b. Set active deployment + mark retained
        await setActiveDeployment(c.get('db'), projectId, deployment.id);
        await markDeploymentRetained(c.get('db'), deployment.id, true);

        // Legacy cleanup — delete unversioned worker script (safe no-op if already gone)
        const legacyWorkerName = `user-${project.slug}`;
        await deleteDispatchScript(
          c.env.CF_ACCOUNT_ID,
          c.env.CF_API_TOKEN,
          dispatchNamespace,
          legacyWorkerName,
        );

        // Retention cleanup — delete old worker scripts beyond plan limit
        const retentionLimit = planLimits.retainedDeployments;
        if (retentionLimit > 0) {
          const retained = await getRetainedDeploymentsExcluding(
            c.get('db'),
            projectId,
            deployment.id,
          );
          // retentionLimit includes the active deployment, so keep (limit - 1) others
          const toEvict = retained.slice(retentionLimit - 1);

          // Build retained-hash set across current + kept deployments so the
          // R2/KV mirror GC below doesn't evict hashes still referenced by
          // a retained deployment. See meta/design-docs/0066.
          let retainedHashes: Set<string> | null = null;
          if (toEvict.length > 0) {
            retainedHashes = new Set<string>();
            for (const [, entry] of Object.entries(assetManifest)) {
              retainedHashes.add(entry.hash);
            }
            const keptDeployments = retained.slice(0, retentionLimit - 1);
            for (const kept of keptDeployments) {
              if (kept.asset_hashes) {
                const keptManifest = JSON.parse(kept.asset_hashes) as Record<
                  string,
                  { hash: string }
                >;
                for (const entry of Object.values(keptManifest)) {
                  retainedHashes.add(entry.hash);
                }
              }
            }
          }

          for (const old of toEvict) {
            const oldWorkerName = `user-${project.slug}-${old.id}`;
            await deleteDispatchScript(
              c.env.CF_ACCOUNT_ID,
              c.env.CF_API_TOKEN,
              dispatchNamespace,
              oldWorkerName,
            );
            // Evict mirrored assets + serving manifest written by prior
            // WfP deploys under this plan (pre-mirror deploys have neither).
            if (retainedHashes && old.asset_hashes) {
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
              await c.env.ROUTING.delete(`manifest:${old.id}`);
            }
            await markDeploymentRetained(c.get('db'), old.id, false);
            await clearIsrCache(c.env.ISR_CACHE, projectId, old.id).catch((e) =>
              console.error(`[deploy] failed to clear ISR cache for evicted ${old.id}:`, e),
            );
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
          console.error(`[deploy] raw error before sanitization for ${workerName}: ${raw}`);
        }

        // Sweep streamed static assets only if the slug/domain routing has
        // not yet switched over to this deployment. Once `routingSwitched`
        // is true, the new hashes are actively serving live traffic (via
        // the static serving manifest in ROUTING KV) and deleting them
        // from STATIC_ASSETS/STATIC_ASSETS_R2 would break the live site
        // even though the post-routing recovery branch below keeps the
        // deployment marked live. For non-streamed (buffered) deploys this
        // is a no-op because `streamedHashStores` is empty.
        if (!routingSwitched) {
          await cleanupStreamedAssetsOnAbort();
        }

        // The inner try runs only after `deployment`, `manifest`,
        // `workerName`, and `dispatchNamespace` have all been assigned, so
        // they are non-null here; the non-null assertions satisfy TS because
        // the declarations above are `let ... | undefined`.
        const dep = deployment!;
        const mf = manifest!;
        const wn = workerName!;
        const dn = dispatchNamespace!;

        if (routingSwitched) {
          // Routing already points to this worker — it IS serving live traffic.
          // Mark as "live" so DB state matches reality. The late-step failure
          // (retention cleanup, asset_hashes update, etc.) is non-critical and
          // will self-correct on the next deploy.
          console.error(`[deploy] post-routing step failed for ${wn}: ${msg}`);
          await updateDeploymentStatus(c.get('db'), dep.id, 'live', undefined, {
            force: true,
          }).catch(() => {});
          await updateProjectType(
            c.get('db'),
            projectId,
            mf.type ?? (mf.framework ? 'framework' : 'void'),
          ).catch(() => {});
          await setActiveDeployment(c.get('db'), projectId, dep.id).catch(() => {});
          await markDeploymentRetained(c.get('db'), dep.id, true).catch(() => {});
          // Emit "done" so the CLI shows success with the URL — the deploy IS live.
          const siteDomain = c.env.SITE_DOMAIN ?? SITE_DOMAIN;
          const slugUrl = `https://${project.slug}.${siteDomain}`;
          emit({
            event: 'done',
            deployment: dep.id,
            url: slugUrl,
            urls: [slugUrl],
            assets: 0,
            workers: 0,
          });
        } else {
          // Routing not yet switched — safe to clean up the worker script and
          // mark the deployment as failed.
          const latest = await getDeployment(c.get('db'), dep.id);
          const wasCanceled =
            latest && CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status);
          await deleteDispatchScript(c.env.CF_ACCOUNT_ID, c.env.CF_API_TOKEN, dn, wn).catch((e) =>
            console.error(`[deploy] failed to clean up worker script ${wn}:`, e),
          );
          await clearIsrCache(c.env.ISR_CACHE, projectId, dep.id).catch((e) =>
            console.error(`[deploy] failed to clear ISR cache for ${dep.id}:`, e),
          );
          // Clear cron DO if we synced it before the failure (step 2c runs before routing switch)
          if (cronSynced) {
            const cronId = c.env.CRON_SCHEDULER.idFromName(projectId);
            await c.env.CRON_SCHEDULER.get(cronId)
              .fetch(new Request('https://do/clear', { method: 'POST' }))
              .catch((e) =>
                console.error(`[deploy] failed to clear cron scheduler for ${projectId}:`, e),
              );
          }
          if (!wasCanceled) {
            await updateDeploymentStatus(c.get('db'), dep.id, 'failed', msg);
          } else {
            await updateDeploymentStatus(c.get('db'), dep.id, 'canceled', msg, {
              force: true,
            });
          }
          emit({ event: 'error', message: msg, step: currentStep });
          if (!wasCanceled && c.env.EMAIL && user.email) {
            const dashboardUrl = c.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
            c.executionCtx.waitUntil(
              sendDeployFailedEmail(c.env.EMAIL, user.email, project.slug, msg, dashboardUrl).catch(
                (err) => console.error(`[deploy-failed-email] Failed for ${project.slug}:`, err),
              ),
            );
          }
        }
      }
    } catch (err) {
      console.error(`[deploy] ${projectId}: unhandled error in deploy pipeline:`, err);
      try {
        await cleanupStreamedAssetsOnAbort();
      } catch {
        // ignore — best-effort cleanup on unhandled path
      }
      // Emit a generic message — unhandled errors here can carry DB query
      // fragments, CF provider responses, or other internal details that
      // must not leak to deploy clients. The raw error is logged above for
      // operator debugging. Inner pipeline failures have their own sanitized
      // emit path earlier in the try block.
      emit({
        event: 'error',
        message: 'deploy failed due to an internal error',
        step: currentStep,
      });
    } finally {
      clearInterval(heartbeat);
      try {
        await cleanupOwnStreamedAssetClaims();
      } catch {
        // ignore — best-effort cleanup on unhandled path
      }
      streamOpen = false;
      try {
        await writer.close();
      } catch {
        // ignore — writer may already be closed if the client disconnected
      }
    }
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
});

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
    if (matchPattern(pattern, pathname)) {
      return ttl;
    }
  }
  return 0;
}

const MAX_CACHE = 256;
const regexCache = new Map<string, RegExp>();

/**
 * Match a pattern against a pathname.
 * `*` matches any characters including `/`.
 */
function matchPattern(pattern: string, pathname: string): boolean {
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
