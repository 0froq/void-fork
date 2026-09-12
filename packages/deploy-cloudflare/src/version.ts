import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { parseRootWranglerConfig } from './config.ts';
import type { CloudflareCommandResult, CloudflareCommandRunner } from './execute.ts';

const VERSION_ID_RE = /(?:Worker|Current) Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i;
const PREVIEW_URL_RE = /Version Preview(?: Alias)? URL:\s*(https:\/\/\S+)/i;
const WORKERS_DEV_URL_RE = /(https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s]*)?)/i;
const CLOUDFLARE_ERROR_CODE_RE = /\[code:\s*(\d+)\]/i;
const DURABLE_MIGRATION_VERSION_ERROR = 10211;

export type CloudflareVersionMetadata = Readonly<{
  schema: 1;
  migrations: ReadonlyArray<string>;
  triggerConfig?: CloudflareTriggerConfig;
}>;

export type CloudflareTriggerConfig = Readonly<{
  workers_dev?: boolean;
  routes: ReadonlyArray<unknown>;
  crons: ReadonlyArray<unknown>;
  queueConsumers: ReadonlyArray<unknown>;
  workflows: ReadonlyArray<unknown>;
}>;

export type CloudflareVersionActivation =
  | {
      ok: true;
      versionId: string;
      previewUrl: string;
      previousVersionId: string | null;
      workersDevSubdomain?: string;
    }
  | {
      ok: false;
      reason:
        | 'uploader-changed'
        | 'status-failed'
        | 'traffic-split-unsupported'
        | 'upload-failed'
        | 'upload-output-invalid'
        | 'preview-unavailable'
        | 'readiness-staging-failed'
        | 'readiness-failed'
        | 'readiness-access-denied'
        | 'bootstrap-failed'
        | 'bootstrap-output-invalid'
        | 'bootstrap-readiness-failed'
        | 'bootstrap-readiness-access-denied'
        | 'activation-failed'
        | 'triggers-failed';
      status?: number;
      cloudflareErrorCode?: number;
      /** Wrangler reached Cloudflare's Containers entitlement endpoint and received a 403. */
      containersUnavailable?: boolean;
      versionId?: string;
      previousVersionId?: string | null;
      rollback?: 'not-needed' | 'succeeded' | 'failed' | 'unavailable' | 'unsafe';
    };

type ProductionDeployment = Readonly<{
  versions?: ReadonlyArray<Readonly<{ version_id?: unknown; percentage?: unknown }>>;
}>;

/** Encode migration state into Cloudflare's version annotation for safe rollback diagnostics. */
export function encodeCloudflareVersionMessage(
  migrations: ReadonlyArray<string>,
  triggerConfig?: CloudflareTriggerConfig,
): string {
  return `void:${JSON.stringify({ schema: 1, migrations, triggerConfig } satisfies CloudflareVersionMetadata)}`;
}

/** Read migration state written by {@link encodeCloudflareVersionMessage}. */
export function parseCloudflareVersionMessage(
  message: string | null | undefined,
): CloudflareVersionMetadata | null {
  if (!message?.startsWith('void:')) {
    return null;
  }
  try {
    const value = JSON.parse(message.slice(5)) as Partial<CloudflareVersionMetadata>;
    if (
      value.schema !== 1 ||
      !Array.isArray(value.migrations) ||
      !value.migrations.every((migration): migration is string => typeof migration === 'string')
    ) {
      return null;
    }
    const triggerConfig = parseTriggerConfig(value.triggerConfig);
    if (value.triggerConfig !== undefined && triggerConfig === null) {
      return null;
    }
    return { schema: 1, migrations: value.migrations, ...(triggerConfig ? { triggerConfig } : {}) };
  } catch {
    return null;
  }
}

/** Capture every configuration surface mutated by `wrangler triggers deploy`. */
export function readCloudflareTriggerConfig(configPath: string): CloudflareTriggerConfig {
  return triggerConfigFromWrangler(parseRootWranglerConfig(configPath));
}

/** Apply a version's persisted trigger state using an isolated temporary Wrangler config. */
export async function deployCloudflareVersionTriggers(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  configPath?: string;
  triggerConfig: CloudflareTriggerConfig;
}): Promise<CloudflareCommandResult> {
  const base = options.configPath ? parseRootWranglerConfig(options.configPath) : {};
  const config = triggerWranglerConfig(base, options.triggerConfig);
  const directory = mkdtempSync(join(tmpdir(), 'void-version-triggers-'));
  const configPath = join(directory, 'wrangler.json');
  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return await options.runWrangler(
      ['triggers', 'deploy', '-c', configPath, '--env=', '--name', options.workerName],
      { capture: false },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function triggerConfigFromWrangler(config: Record<string, unknown>): CloudflareTriggerConfig {
  const triggers = isRecord(config.triggers) ? config.triggers : {};
  const queues = isRecord(config.queues) ? config.queues : {};
  const routes = Array.isArray(config.routes)
    ? config.routes
    : config.route === undefined
      ? []
      : [config.route];
  return {
    ...(typeof config.workers_dev === 'boolean' ? { workers_dev: config.workers_dev } : {}),
    routes,
    crons: Array.isArray(triggers.crons) ? triggers.crons : [],
    queueConsumers: Array.isArray(queues.consumers) ? queues.consumers : [],
    workflows: Array.isArray(config.workflows) ? config.workflows : [],
  };
}

function parseTriggerConfig(value: unknown): CloudflareTriggerConfig | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (
    (value.workers_dev !== undefined && typeof value.workers_dev !== 'boolean') ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.crons) ||
    !Array.isArray(value.queueConsumers) ||
    !Array.isArray(value.workflows)
  ) {
    return null;
  }
  return {
    ...(typeof value.workers_dev === 'boolean' ? { workers_dev: value.workers_dev } : {}),
    routes: value.routes,
    crons: value.crons,
    queueConsumers: value.queueConsumers,
    workflows: value.workflows,
  };
}

function triggerWranglerConfig(
  base: Record<string, unknown>,
  triggerConfig: CloudflareTriggerConfig,
): Record<string, unknown> {
  const triggers = isRecord(base.triggers) ? { ...base.triggers } : {};
  const queues = isRecord(base.queues) ? { ...base.queues } : {};
  triggers.crons = [...triggerConfig.crons];
  queues.consumers = [...triggerConfig.queueConsumers];
  const config: Record<string, unknown> = {
    ...base,
    routes: [...triggerConfig.routes],
    triggers,
    queues,
    workflows: [...triggerConfig.workflows],
    ...(triggerConfig.workers_dev === undefined ? {} : { workers_dev: triggerConfig.workers_dev }),
  };
  delete config.route;
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Upload, probe, and atomically activate a verified Worker Version. */
export async function activateCloudflareVersion(options: {
  runWrangler: CloudflareCommandRunner;
  verifyUploader: () => boolean;
  workerName: string;
  configPath?: string;
  /** Override only the asset directory for this upload, leaving the persisted config intact. */
  assetsDirectoryOverride?: string;
  /** Optional Cloudflare Access headers used only by the readiness probe. */
  readinessHeaders?: Readonly<Record<string, string>>;
  /** Account workers.dev subdomain used when this Worker cannot expose version preview URLs. */
  workersDevSubdomain?: string;
  message: string;
  /**
   * The caller proved that the Worker did not exist before this deploy provisioned its secrets.
   * Wrangler creates an active placeholder version when attaching the first secret, so the status
   * read below can legitimately observe a version even though no application was ever deployed.
   */
  allowFirstDeploymentBootstrap?: boolean;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  readinessAttempts?: number;
}): Promise<CloudflareVersionActivation> {
  const configArgs = options.configPath ? ['-c', options.configPath] : [];
  const commonArgs = [...configArgs, '--env='];
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const previous = await readCurrentProductionVersion(options, commonArgs);
  if (previous.kind === 'failed') {
    return { ok: false, reason: 'status-failed', status: previous.status };
  }
  if (previous.kind === 'split') {
    return { ok: false, reason: 'traffic-split-unsupported' };
  }
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }

  const alias = `void-ready-${Date.now().toString(36)}`;
  const upload = await Promise.resolve(
    options.runWrangler(
      [
        'versions',
        'upload',
        ...commonArgs,
        '--name',
        options.workerName,
        '--message',
        options.message,
        ...(options.assetsDirectoryOverride ? ['--assets', options.assetsDirectoryOverride] : []),
        '--preview-alias',
        alias,
        '--strict',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
      ],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(upload)) {
    const output = `${upload.stdout}\n${upload.stderr}`;
    const cloudflareErrorCode = parseCloudflareErrorCode(output);
    if (
      (previous.versionId === null || options.allowFirstDeploymentBootstrap === true) &&
      (cloudflareErrorCode === DURABLE_MIGRATION_VERSION_ERROR ||
        /cannot upload a new version of a worker that does not yet exist/i.test(output))
    ) {
      return bootstrapFirstDeployment(options, commonArgs, previous.versionId);
    }
    return {
      ok: false,
      reason: 'upload-failed',
      status: upload.status,
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      ...(isContainersUnavailable(output) ? { containersUnavailable: true } : {}),
    };
  }

  const output = `${upload.stdout}\n${upload.stderr}`;
  const versionId = output.match(VERSION_ID_RE)?.[1];
  if (!versionId) {
    return { ok: false, reason: 'upload-output-invalid' };
  }
  const reportedPreviewUrl = output.match(PREVIEW_URL_RE)?.[1];
  let readinessUrl = reportedPreviewUrl;
  let stagedVersionOverride = false;
  if (!readinessUrl) {
    if (previous.versionId === null || options.allowFirstDeploymentBootstrap === true) {
      return bootstrapFirstDeployment(options, commonArgs, previous.versionId);
    }
    readinessUrl = workersDevReadinessUrl(options.workerName, options.workersDevSubdomain);
    if (!readinessUrl) {
      return {
        ok: false,
        reason: 'preview-unavailable',
        versionId,
        previousVersionId: previous.versionId,
      };
    }
    if (!options.verifyUploader()) {
      return {
        ok: false,
        reason: 'uploader-changed',
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    const staged = await deployVersionPercentages(
      options,
      commonArgs,
      [`${previous.versionId}@100`, `${versionId}@0`],
      options.message,
    );
    if (!isCleanCommandExit(staged)) {
      return {
        ok: false,
        reason: 'readiness-staging-failed',
        status: staged.status,
        versionId,
        previousVersionId: previous.versionId,
        rollback: 'not-needed',
      };
    }
    stagedVersionOverride = true;
  }

  let ready = await probeReadiness(
    `${readinessUrl.replace(/\/$/, '')}/__void/ready`,
    options.workerName,
    options.readinessHeaders,
    stagedVersionOverride ? versionId : undefined,
    options.fetch ?? globalThis.fetch,
    options.sleep ?? defaultSleep,
    options.readinessAttempts ?? 6,
  );

  // Account-wide Access default-deny commonly blocks Wrangler's generated preview alias even
  // when the stable `<worker>.<account>.workers.dev` destination has an application admitting the
  // operator or a service token. The preview response gives us the account subdomain, so preserve
  // the same no-traffic readiness invariant by staging the uploaded version at 0% and selecting it
  // explicitly through the stable, policy-covered hostname. This requires a prior active version
  // whose traffic can remain untouched while the new version is staged; a truly empty first
  // deployment has no safe zero-percent fallback.
  if (ready === 'access-denied' && !stagedVersionOverride && previous.versionId !== null) {
    const stableReadinessUrl = workersDevReadinessUrl(
      options.workerName,
      options.workersDevSubdomain ?? extractWorkersDevSubdomain(readinessUrl),
    );
    if (stableReadinessUrl && stableReadinessUrl !== readinessUrl) {
      if (!options.verifyUploader()) {
        return {
          ok: false,
          reason: 'uploader-changed',
          versionId,
          previousVersionId: previous.versionId,
          rollback: 'not-needed',
        };
      }
      const staged = await deployVersionPercentages(
        options,
        commonArgs,
        [`${previous.versionId}@100`, `${versionId}@0`],
        options.message,
      );
      if (!isCleanCommandExit(staged)) {
        return {
          ok: false,
          reason: 'readiness-staging-failed',
          status: staged.status,
          versionId,
          previousVersionId: previous.versionId,
          rollback: 'not-needed',
        };
      }
      readinessUrl = stableReadinessUrl;
      stagedVersionOverride = true;
      ready = await probeReadiness(
        `${readinessUrl.replace(/\/$/, '')}/__void/ready`,
        options.workerName,
        options.readinessHeaders,
        versionId,
        options.fetch ?? globalThis.fetch,
        options.sleep ?? defaultSleep,
        options.readinessAttempts ?? 6,
      );
    }
  }
  if (ready !== 'ready') {
    return {
      ok: false,
      reason: ready === 'access-denied' ? 'readiness-access-denied' : 'readiness-failed',
      versionId,
      previousVersionId: previous.versionId,
      rollback: stagedVersionOverride
        ? await restorePreviousVersion(options, commonArgs, previous.versionId, 'readiness failed')
        : 'not-needed',
    };
  }
  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
      rollback: stagedVersionOverride
        ? await restorePreviousVersion(
            options,
            commonArgs,
            previous.versionId,
            'uploader verification failed',
          )
        : 'not-needed',
    };
  }

  const activate = await deployVersionPercentages(
    options,
    commonArgs,
    [`${versionId}@100`],
    options.message,
  );
  if (!isCleanCommandExit(activate)) {
    return {
      ok: false,
      reason: 'activation-failed',
      status: activate.status,
      versionId,
      previousVersionId: previous.versionId,
      rollback: stagedVersionOverride
        ? await restorePreviousVersion(
            options,
            commonArgs,
            previous.versionId,
            'version activation failed',
          )
        : 'not-needed',
    };
  }

  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
      // Never invoke a binary that just failed integrity verification, even to
      // restore traffic. The active version must be repaired with a trusted
      // Wrangler installation instead.
      rollback: previous.versionId ? 'unsafe' : 'unavailable',
    };
  }
  const triggers = await Promise.resolve(
    options.runWrangler(['triggers', 'deploy', ...commonArgs, '--name', options.workerName], {
      capture: false,
    }),
  );
  if (!isCleanCommandExit(triggers)) {
    const rollback = await restorePreviousVersionAndTriggers(
      options,
      commonArgs,
      previous.versionId,
      'trigger activation failed',
    );
    return {
      ok: false,
      reason: 'triggers-failed',
      status: triggers.status,
      versionId,
      previousVersionId: previous.versionId,
      rollback,
    };
  }

  return {
    ok: true,
    versionId,
    previewUrl: readinessUrl,
    previousVersionId: previous.versionId,
    ...workersDevSubdomainResult(readinessUrl),
  };
}

async function restorePreviousVersionAndTriggers(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'configPath' | 'runWrangler' | 'verifyUploader' | 'workerName'
  >,
  commonArgs: Array<string>,
  previousVersionId: string | null,
  cause: string,
): Promise<'succeeded' | 'failed' | 'unavailable' | 'unsafe'> {
  const traffic = await restorePreviousVersion(options, commonArgs, previousVersionId, cause);
  if (traffic !== 'succeeded' || !previousVersionId) {
    return traffic;
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  const metadata = await readCloudflareVersionMetadata(options, commonArgs, previousVersionId);
  if (!metadata?.triggerConfig) {
    return 'unavailable';
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  const triggers = await deployCloudflareVersionTriggers({
    runWrangler: options.runWrangler,
    workerName: options.workerName,
    configPath: options.configPath,
    triggerConfig: metadata.triggerConfig,
  });
  return isCleanCommandExit(triggers) ? 'succeeded' : 'failed';
}

async function readCloudflareVersionMetadata(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  versionId: string,
): Promise<CloudflareVersionMetadata | null> {
  const result = await Promise.resolve(
    options.runWrangler(
      ['versions', 'list', ...commonArgs, '--name', options.workerName, '--json'],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(result)) {
    return null;
  }
  try {
    const versions = JSON.parse(result.stdout) as Array<unknown>;
    if (!Array.isArray(versions)) {
      return null;
    }
    for (const entry of versions) {
      if (!isRecord(entry) || entry.id !== versionId || !isRecord(entry.annotations)) {
        continue;
      }
      const message = entry.annotations['workers/message'];
      return typeof message === 'string' ? parseCloudflareVersionMessage(message) : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The Versions API cannot create a Worker or its initial Durable Object migration history, and
 * some accounts do not expose a version preview until their first ordinary deployment. A
 * brand-new Worker can therefore need one ordinary deploy before later releases use preview-first
 * version activation. This fallback requires prior proof that no application had been deployed.
 */
async function bootstrapFirstDeployment(
  options: Parameters<typeof activateCloudflareVersion>[0],
  commonArgs: Array<string>,
  previousVersionId: string | null,
): Promise<CloudflareVersionActivation> {
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const bootstrap = await Promise.resolve(
    options.runWrangler(
      [
        'deploy',
        ...commonArgs,
        '--name',
        options.workerName,
        '--message',
        options.message,
        ...(options.assetsDirectoryOverride ? ['--assets', options.assetsDirectoryOverride] : []),
        '--strict',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        '--autoconfig=false',
      ],
      { capture: true },
    ),
  );
  const output = `${bootstrap.stdout}\n${bootstrap.stderr}`;
  if (!isCleanCommandExit(bootstrap)) {
    const cloudflareErrorCode = parseCloudflareErrorCode(output);
    return {
      ok: false,
      reason: 'bootstrap-failed',
      status: bootstrap.status,
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
      ...(isContainersUnavailable(output) ? { containersUnavailable: true } : {}),
    };
  }
  const versionId = output.match(VERSION_ID_RE)?.[1];
  const previewUrl = output.match(PREVIEW_URL_RE)?.[1] ?? output.match(WORKERS_DEV_URL_RE)?.[1];
  if (!versionId || !previewUrl) {
    return {
      ok: false,
      reason: 'bootstrap-output-invalid',
      previousVersionId,
      ...(versionId ? { versionId } : {}),
    };
  }
  const ready = await probeReadiness(
    `${previewUrl.replace(/\/$/, '')}/__void/ready`,
    options.workerName,
    options.readinessHeaders,
    undefined,
    options.fetch ?? globalThis.fetch,
    options.sleep ?? defaultSleep,
    options.readinessAttempts ?? 6,
  );
  if (ready !== 'ready') {
    return {
      ok: false,
      reason:
        ready === 'access-denied'
          ? 'bootstrap-readiness-access-denied'
          : 'bootstrap-readiness-failed',
      versionId,
      previousVersionId,
      rollback: 'unavailable',
    };
  }
  return {
    ok: true,
    versionId,
    previewUrl,
    previousVersionId,
    ...workersDevSubdomainResult(previewUrl),
  };
}

function parseCloudflareErrorCode(output: string): number | undefined {
  const value = output.match(CLOUDFLARE_ERROR_CODE_RE)?.[1];
  return value === undefined ? undefined : Number(value);
}

/** Recognize the Containers account-entitlement failure Wrangler exposes during upload. */
function isContainersUnavailable(output: string): boolean {
  return (
    (/\/containers\/me(?:\b|\?)/i.test(output) && /\b403\b/.test(output)) ||
    /Cloudflare Containers[^\n]*(?:Workers Paid|not (?:enabled|available)|subscription)/i.test(
      output,
    )
  );
}

async function readCurrentProductionVersion(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
): Promise<
  { kind: 'ok'; versionId: string | null } | { kind: 'failed'; status: number } | { kind: 'split' }
> {
  const result = await Promise.resolve(
    options.runWrangler(
      ['deployments', 'status', ...commonArgs, '--name', options.workerName, '--json'],
      { capture: true },
    ),
  );
  if (!isCleanCommandExit(result)) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (
      parseCloudflareErrorCode(output) === 10007 ||
      /no deployments|\bworker\b.*\b(?:does not exist|not found)\b/i.test(output)
    ) {
      return { kind: 'ok', versionId: null };
    }
    return { kind: 'failed', status: result.status };
  }
  try {
    const deployment = JSON.parse(result.stdout) as ProductionDeployment;
    const versions = (deployment.versions ?? []).filter(
      (version) => Number(version.percentage) > 0,
    );
    if (versions.length > 1 || (versions.length === 1 && Number(versions[0]?.percentage) !== 100)) {
      return { kind: 'split' };
    }
    const active = versions[0];
    return {
      kind: 'ok',
      versionId: typeof active?.version_id === 'string' ? active.version_id : null,
    };
  } catch {
    return { kind: 'failed', status: result.status };
  }
}

async function probeReadiness(
  url: string,
  workerName: string,
  readinessHeaders: Readonly<Record<string, string>> | undefined,
  versionOverride: string | undefined,
  fetcher: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<'ready' | 'failed' | 'access-denied'> {
  const headers = guardedReadinessHeaders(url, workerName, readinessHeaders);
  if (headers === null) {
    return 'failed';
  }
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      const response = await fetcher(url, {
        headers: {
          'user-agent': 'void-deploy-readiness/1',
          ...headers,
          ...(versionOverride
            ? {
                'Cloudflare-Workers-Version-Overrides': `${workerName}="${versionOverride}"`,
              }
            : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { ready?: unknown };
        if (body.ready === true) {
          return 'ready';
        }
      } else if (await isCloudflareAccessDenial(response)) {
        return 'access-denied';
      }
    } catch {
      // Preview propagation is eventually consistent; retry below.
    }
    if (attempt + 1 < attempts) {
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
    }
  }
  return 'failed';
}

/** Never forward Access headers to a hostname that cannot be this Worker. */
function guardedReadinessHeaders(
  url: string,
  workerName: string,
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | null {
  if (!headers || Object.keys(headers).length === 0) {
    return {};
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const firstLabel = hostname.split('.')[0] ?? '';
    const normalizedWorkerName = workerName.toLowerCase();
    if (
      parsed.protocol !== 'https:' ||
      !hostname.endsWith('.workers.dev') ||
      (firstLabel !== normalizedWorkerName && !firstLabel.endsWith(`-${normalizedWorkerName}`))
    ) {
      return null;
    }
    return headers;
  } catch {
    return null;
  }
}

async function isCloudflareAccessDenial(response: Response): Promise<boolean> {
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.get('location')?.includes('/cdn-cgi/access/')
  ) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  if (response.headers.get('cf-mitigated') === 'challenge') {
    return true;
  }
  try {
    return /(?:error\s+code:\s*)?1050\b/i.test(await response.text());
  } catch {
    return false;
  }
}

async function deployVersionPercentages(
  options: Pick<Parameters<typeof activateCloudflareVersion>[0], 'runWrangler' | 'workerName'>,
  commonArgs: Array<string>,
  percentages: Array<string>,
  message: string,
): Promise<CloudflareCommandResult> {
  return options.runWrangler(
    [
      'versions',
      'deploy',
      ...percentages,
      ...commonArgs,
      '--name',
      options.workerName,
      '--message',
      message,
      '--yes',
    ],
    { capture: false },
  );
}

async function restorePreviousVersion(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'runWrangler' | 'verifyUploader' | 'workerName'
  >,
  commonArgs: Array<string>,
  previousVersionId: string | null,
  cause: string,
): Promise<'succeeded' | 'failed' | 'unavailable' | 'unsafe'> {
  if (!previousVersionId) {
    return 'unavailable';
  }
  if (!options.verifyUploader()) {
    return 'unsafe';
  }
  const result = await deployVersionPercentages(
    options,
    commonArgs,
    [`${previousVersionId}@100`],
    `Void automatic rollback after ${cause}.`,
  );
  return isCleanCommandExit(result) ? 'succeeded' : 'failed';
}

function workersDevReadinessUrl(workerName: string, value: string | undefined): string | undefined {
  const subdomain = normalizeWorkersDevSubdomain(value);
  if (!subdomain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
    return undefined;
  }
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/** Normalize an account workers.dev subdomain supplied by config or the environment. */
export function normalizeWorkersDevSubdomain(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/\.workers\.dev\/?$/, '');
  if (!normalized || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.fed)?$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

/** Extract the account subdomain from a Wrangler-reported workers.dev URL. */
export function extractWorkersDevSubdomain(url: string): string | undefined {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.');
    if (labels.at(-2) !== 'workers' || labels.at(-1) !== 'dev') {
      return undefined;
    }
    if (labels.length === 4) {
      return normalizeWorkersDevSubdomain(labels[1]);
    }
    if (labels.length === 5 && labels[2] === 'fed') {
      return normalizeWorkersDevSubdomain(`${labels[1]}.fed`);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function workersDevSubdomainResult(url: string): { workersDevSubdomain?: string } {
  const workersDevSubdomain = extractWorkersDevSubdomain(url);
  return workersDevSubdomain ? { workersDevSubdomain } : {};
}

function isCleanCommandExit(result: CloudflareCommandResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
