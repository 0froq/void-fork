import type { CloudflareCommandResult, CloudflareCommandRunner } from './execute.ts';

const VERSION_ID_RE = /(?:Worker|Current) Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i;
const PREVIEW_URL_RE = /Version Preview(?: Alias)? URL:\s*(https:\/\/\S+)/i;
const WORKERS_DEV_URL_RE = /(https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s]*)?)/i;
const CLOUDFLARE_ERROR_CODE_RE = /\[code:\s*(\d+)\]/i;
const DURABLE_MIGRATION_VERSION_ERROR = 10211;

export type CloudflareVersionMetadata = Readonly<{
  schema: 1;
  migrations: ReadonlyArray<string>;
}>;

export type CloudflareVersionActivation =
  | {
      ok: true;
      versionId: string;
      previewUrl: string;
      previousVersionId: string | null;
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
        | 'readiness-failed'
        | 'bootstrap-failed'
        | 'bootstrap-output-invalid'
        | 'bootstrap-readiness-failed'
        | 'activation-failed'
        | 'triggers-failed';
      status?: number;
      cloudflareErrorCode?: number;
      versionId?: string;
      previousVersionId?: string | null;
      rollback?: 'not-needed' | 'succeeded' | 'failed' | 'unavailable';
    };

type ProductionDeployment = Readonly<{
  versions?: ReadonlyArray<Readonly<{ version_id?: unknown; percentage?: unknown }>>;
}>;

/** Encode migration state into Cloudflare's version annotation for safe rollback diagnostics. */
export function encodeCloudflareVersionMessage(migrations: ReadonlyArray<string>): string {
  return `void:${JSON.stringify({ schema: 1, migrations } satisfies CloudflareVersionMetadata)}`;
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
    return { schema: 1, migrations: value.migrations };
  } catch {
    return null;
  }
}

/** Upload, probe, and atomically activate a verified Worker Version. */
export async function activateCloudflareVersion(options: {
  runWrangler: CloudflareCommandRunner;
  verifyUploader: () => boolean;
  workerName: string;
  configPath?: string;
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
      cloudflareErrorCode === DURABLE_MIGRATION_VERSION_ERROR &&
      (previous.versionId === null || options.allowFirstDeploymentBootstrap === true)
    ) {
      return bootstrapFirstDeployment(options, commonArgs, previous.versionId);
    }
    return {
      ok: false,
      reason: 'upload-failed',
      status: upload.status,
      ...(cloudflareErrorCode === undefined ? {} : { cloudflareErrorCode }),
    };
  }

  const output = `${upload.stdout}\n${upload.stderr}`;
  const versionId = output.match(VERSION_ID_RE)?.[1];
  if (!versionId) {
    return { ok: false, reason: 'upload-output-invalid' };
  }
  const previewUrl = output.match(PREVIEW_URL_RE)?.[1];
  if (!previewUrl) {
    if (previous.versionId === null || options.allowFirstDeploymentBootstrap === true) {
      return bootstrapFirstDeployment(options, commonArgs, previous.versionId);
    }
    return {
      ok: false,
      reason: 'preview-unavailable',
      versionId,
      previousVersionId: previous.versionId,
    };
  }

  const ready = await probeReadiness(
    `${previewUrl.replace(/\/$/, '')}/__void/ready`,
    options.fetch ?? globalThis.fetch,
    options.sleep ?? defaultSleep,
    options.readinessAttempts ?? 6,
  );
  if (!ready) {
    return {
      ok: false,
      reason: 'readiness-failed',
      versionId,
      previousVersionId: previous.versionId,
      rollback: 'not-needed',
    };
  }
  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
    };
  }

  const activate = await Promise.resolve(
    options.runWrangler(
      [
        'versions',
        'deploy',
        `${versionId}@100`,
        ...commonArgs,
        '--name',
        options.workerName,
        '--message',
        options.message,
        '--yes',
      ],
      { capture: false },
    ),
  );
  if (!isCleanCommandExit(activate)) {
    return {
      ok: false,
      reason: 'activation-failed',
      status: activate.status,
      versionId,
      previousVersionId: previous.versionId,
      rollback: 'not-needed',
    };
  }

  if (!options.verifyUploader()) {
    return {
      ok: false,
      reason: 'uploader-changed',
      versionId,
      previousVersionId: previous.versionId,
    };
  }
  const triggers = await Promise.resolve(
    options.runWrangler(['triggers', 'deploy', ...commonArgs, '--name', options.workerName], {
      capture: false,
    }),
  );
  if (!isCleanCommandExit(triggers)) {
    const rollback = await rollbackAfterTriggerFailure(options, commonArgs, previous.versionId);
    return {
      ok: false,
      reason: 'triggers-failed',
      status: triggers.status,
      versionId,
      previousVersionId: previous.versionId,
      rollback,
    };
  }

  return { ok: true, versionId, previewUrl, previousVersionId: previous.versionId };
}

/**
 * Cloudflare cannot create Durable Object migration history through the Versions API, and some
 * accounts do not expose a version preview until their first ordinary deployment. A brand-new
 * Worker can therefore need one ordinary deploy before later releases use preview-first version
 * activation. This fallback requires prior proof that no application had been deployed.
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
    options.fetch ?? globalThis.fetch,
    options.sleep ?? defaultSleep,
    options.readinessAttempts ?? 6,
  );
  if (!ready) {
    return {
      ok: false,
      reason: 'bootstrap-readiness-failed',
      versionId,
      previousVersionId,
      rollback: 'unavailable',
    };
  }
  return { ok: true, versionId, previewUrl, previousVersionId };
}

function parseCloudflareErrorCode(output: string): number | undefined {
  const value = output.match(CLOUDFLARE_ERROR_CODE_RE)?.[1];
  return value === undefined ? undefined : Number(value);
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
    if (/no deployments|worker .* (?:does not exist|not found)/i.test(output)) {
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
  fetcher: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { 'user-agent': 'void-deploy-readiness/1' },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { ready?: unknown };
        if (body.ready === true) {
          return true;
        }
      }
    } catch {
      // Preview propagation is eventually consistent; retry below.
    }
    if (attempt + 1 < attempts) {
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
    }
  }
  return false;
}

async function rollbackAfterTriggerFailure(
  options: Pick<
    Parameters<typeof activateCloudflareVersion>[0],
    'runWrangler' | 'verifyUploader' | 'workerName'
  >,
  commonArgs: Array<string>,
  previousVersionId: string | null,
): Promise<'succeeded' | 'failed' | 'unavailable'> {
  if (!previousVersionId) {
    return 'unavailable';
  }
  if (!options.verifyUploader()) {
    return 'failed';
  }
  const result = await Promise.resolve(
    options.runWrangler(
      [
        'versions',
        'deploy',
        `${previousVersionId}@100`,
        ...commonArgs,
        '--name',
        options.workerName,
        '--message',
        'Void automatic rollback after trigger activation failed.',
        '--yes',
      ],
      { capture: false },
    ),
  );
  return isCleanCommandExit(result) ? 'succeeded' : 'failed';
}

function isCleanCommandExit(result: CloudflareCommandResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
