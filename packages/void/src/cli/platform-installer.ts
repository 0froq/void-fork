import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  createPlatformWorkerConfigs,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  setInstallationEndpoints,
  transitionInstallation,
  type InstallationResource,
  type PlatformInstallationManifest,
} from '@void/platform';
import { getPlatformRuntimeDirectory, readPlatformRuntimeManifest } from '@void/platform/installer';
import { join } from 'pathslash';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';
import {
  platformProvisionIntentHash,
  type PlatformInstallPlan,
  type PlatformInstallPlanAction,
} from './platform-plan.ts';
import {
  promoteInstallationSecrets,
  savePlatformConnection,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import { resolveWranglerArgv } from './preset.ts';

export const REMOTE_INSTALLATION_MANIFEST_KEY: string = PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY;

export type PlatformInstallationSecrets = Readonly<{
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  jwtSecret: string;
  projectSecretKey: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
}>;

type InstallerClient = Pick<
  PlatformCloudflareClient,
  | 'createDispatchNamespace'
  | 'createDnsRecord'
  | 'createAiGateway'
  | 'createHyperdrive'
  | 'createKvNamespace'
  | 'createQueue'
  | 'createR2Bucket'
  | 'createZone'
  | 'putKvValue'
  | 'putR2Object'
>;

export type PlatformInstallerDependencies = Readonly<{
  client: InstallerClient;
  deployWorker?: (
    config: Record<string, unknown>,
    secrets: Record<string, string> | null,
  ) => Promise<void>;
  migrateDatabase?: (databaseUrl: string, migrationsFolder: string) => Promise<void>;
  now?: () => string;
  verifyHealth?: (apiUrl: string, installationId: string) => Promise<void>;
}>;

export type PlatformInstallationResult = Readonly<{
  manifest: PlatformInstallationManifest;
  waitingForDns: boolean;
  zoneNameServers: ReadonlyArray<string>;
}>;

export function createPlatformInstallationSecrets(input: {
  bootstrapGitHubId: string;
  bootstrapGitHubLogin: string;
  cloudflareApiToken: string;
  databaseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  checkpoint?: Record<string, string> | null;
}): PlatformInstallationSecrets {
  const checkpoint = input.checkpoint ?? {};
  const required = (value: string, name: string): string => {
    if (!value) {
      throw new Error(`platform: ${name} is required to install the platform.`);
    }
    return value;
  };
  return {
    bootstrapGitHubId: required(
      input.bootstrapGitHubId || checkpoint.bootstrapGitHubId || '',
      'resolved administrator GitHub account id',
    ),
    bootstrapGitHubLogin: required(
      input.bootstrapGitHubLogin || checkpoint.bootstrapGitHubLogin || '',
      'VOID_PLATFORM_ADMIN_GITHUB_LOGIN',
    ),
    cloudflareApiToken: required(input.cloudflareApiToken, 'CLOUDFLARE_API_TOKEN'),
    databaseUrl: required(input.databaseUrl || checkpoint.databaseUrl || '', 'DATABASE_URL'),
    githubClientId: required(
      input.githubClientId || checkpoint.githubClientId || '',
      'VOID_PLATFORM_GITHUB_CLIENT_ID',
    ),
    githubClientSecret: required(
      input.githubClientSecret || checkpoint.githubClientSecret || '',
      'VOID_PLATFORM_GITHUB_CLIENT_SECRET',
    ),
    jwtSecret: checkpoint.jwtSecret || randomBytes(32).toString('base64url'),
    projectSecretKey: checkpoint.projectSecretKey || randomBytes(32).toString('base64'),
    r2AccessKeyId: required(
      input.r2AccessKeyId || checkpoint.r2AccessKeyId || '',
      'VOID_PLATFORM_R2_ACCESS_KEY_ID',
    ),
    r2SecretAccessKey: required(
      input.r2SecretAccessKey || checkpoint.r2SecretAccessKey || '',
      'VOID_PLATFORM_R2_SECRET_ACCESS_KEY',
    ),
  };
}

function secretCheckpoint(secrets: PlatformInstallationSecrets): Record<string, string> {
  return {
    bootstrapGitHubId: secrets.bootstrapGitHubId,
    bootstrapGitHubLogin: secrets.bootstrapGitHubLogin,
    databaseUrl: secrets.databaseUrl,
    githubClientId: secrets.githubClientId,
    githubClientSecret: secrets.githubClientSecret,
    jwtSecret: secrets.jwtSecret,
    projectSecretKey: secrets.projectSecretKey,
    r2AccessKeyId: secrets.r2AccessKeyId,
    r2SecretAccessKey: secrets.r2SecretAccessKey,
  };
}

export async function installPlatform(
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  existing: PlatformInstallationManifest | null,
  dependencies: PlatformInstallerDependencies,
): Promise<PlatformInstallationResult> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const version = readPlatformRuntimeManifest().platformVersion;
  const preserveDisabled = existing?.desiredState === 'disabled';
  let manifest = existing;
  if (!manifest) {
    const createdAt = now();
    manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt,
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: randomBytes(32).toString('base64url'),
      platformVersion: version,
    });
    manifest = transitionInstallation(manifest, 'planned', now());
    writeInstallationManifest(manifest);
  } else if (manifest.status === 'uninstalled') {
    throw new Error(`platform: Installation ${manifest.id} has already been uninstalled.`);
  }
  if (preserveDisabled && manifest.desiredState !== 'disabled') {
    manifest = setInstallationDesiredState(manifest, 'disabled', now());
    writeInstallationManifest(manifest);
  }
  if (manifest.platformVersion !== version) {
    manifest = { ...manifest, platformVersion: version, updatedAt: now() };
    writeInstallationManifest(manifest);
  }
  writePendingInstallationSecrets(manifest, secretCheckpoint(secrets));

  try {
    if (manifest.status !== 'provisioning') {
      manifest = transitionInstallation(manifest, 'provisioning', now());
      writeInstallationManifest(manifest);
    }

    // Establish the durable installation checkpoint before creating any
    // resource that may need to be reconciled or removed after interruption.
    const routingAction = plan.actions.find((action) => action.key === 'routing-kv')!;
    if (routingAction.action === 'adopt') {
      throw new Error('platform: The routing checkpoint cannot be adopted.');
    }
    if (routingAction.action === 'reuse') {
      if (
        !manifest.resources.some((resource) => resource.key === routingAction.key) &&
        routingAction.id
      ) {
        manifest = recordResource(manifest, routingAction, routingAction.id, 'created', now());
        writeInstallationManifest(manifest);
      }
    } else {
      manifest = recordProvisionIntent(manifest, routingAction, now());
      writeInstallationManifest(manifest);
      const routing = await createResource(
        dependencies.client,
        plan,
        routingAction,
        secrets.databaseUrl,
        '',
      );
      manifest = recordResource(manifest, routingAction, routing.id, 'created', now());
      writeInstallationManifest(manifest);
    }
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);

    const zoneAction = plan.actions.find((action) => action.key === 'zone')!;
    let zone = plan.zone;
    if (zoneAction.action === 'create') {
      manifest = recordProvisionIntent(manifest, zoneAction, now());
      writeInstallationManifest(manifest);
      zone = await dependencies.client.createZone(plan.account.id, zoneAction.name);
    }
    if (!zone) {
      throw new Error('platform: Cloudflare did not return the platform zone.');
    }
    manifest = recordResource(
      manifest,
      zoneAction,
      zone.id,
      zoneAction.action === 'adopt'
        ? 'adopted'
        : zoneAction.action === 'create' || hasProvisionIntent(manifest, zoneAction)
          ? 'created'
          : undefined,
      now(),
    );
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    if (zone.status !== 'active') {
      manifest = transitionInstallation(manifest, 'waiting-for-dns', now());
      writeInstallationManifest(manifest);
      return { manifest, waitingForDns: true, zoneNameServers: zone.nameServers };
    }

    for (const action of plan.actions.filter(
      (entry) => entry.key !== 'routing-kv' && entry.kind !== 'zone' && entry.kind !== 'worker',
    )) {
      if (action.action === 'adopt') {
        if (!action.id) {
          throw new Error(`platform: Adopted ${action.kind} ${action.name} has no id.`);
        }
        manifest = recordResource(manifest, action, action.id, 'adopted', now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        continue;
      }
      if (action.action === 'reuse') {
        if (!manifest.resources.some((resource) => resource.key === action.key) && action.id) {
          manifest = recordResource(manifest, action, action.id, 'created', now());
          writeInstallationManifest(manifest);
          await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
          await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
        }
        continue;
      }
      manifest = recordProvisionIntent(manifest, action, now());
      writeInstallationManifest(manifest);
      const resource = await createResource(
        dependencies.client,
        plan,
        action,
        secrets.databaseUrl,
        zone.id,
      );
      manifest = recordResource(manifest, action, resource.id, 'created', now());
      writeInstallationManifest(manifest);
      await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }

    const runtimeDirectory = getPlatformRuntimeDirectory();
    const migrationHash = hash(
      readFileSync(join(runtimeDirectory, 'drizzle', 'meta', '_journal.json')),
    );
    const migrationStep = `database-migrations:${migrationHash}`;
    if (!manifest.steps.some((step) => step.key === migrationStep)) {
      await (dependencies.migrateDatabase ?? migratePlatformDatabase)(
        secrets.databaseUrl,
        join(runtimeDirectory, 'drizzle'),
      );
      manifest = recordInstallationStep(
        manifest,
        { completedAt: now(), key: migrationStep, resultHash: migrationHash },
        now(),
      );
      writeInstallationManifest(manifest);
    }

    manifest = transitionInstallation(manifest, 'deploying', now());
    writeInstallationManifest(manifest);
    const ids = Object.fromEntries(
      manifest.resources.map((resource) => [resource.key, resource.id]),
    );
    const bootstrapStep = 'bootstrap-access:v1';
    if (!manifest.steps.some((step) => step.key === bootstrapStep)) {
      const routingKv = requireId(ids, 'routing-kv');
      await dependencies.client.putKvValue(plan.account.id, routingKv, 'signup:enabled', 'true');
      await dependencies.client.putKvValue(
        plan.account.id,
        routingKv,
        'signup:allowlist',
        JSON.stringify([]),
      );
      manifest = recordInstallationStep(
        manifest,
        {
          completedAt: now(),
          key: bootstrapStep,
          resultHash: hash(secrets.bootstrapGitHubId),
        },
        now(),
      );
      writeInstallationManifest(manifest);
    }
    const runtime = readPlatformRuntimeManifest();
    const entrypoints = Object.fromEntries(
      Object.entries(runtime.artifacts).map(([key, artifact]) => [
        key,
        join(runtimeDirectory, artifact.path),
      ]),
    ) as Record<'api' | 'dispatch' | 'proxy' | 'tail', string>;
    verifyRuntimeArtifacts(runtimeDirectory);
    const configs = createPlatformWorkerConfigs({
      accountId: plan.account.id,
      apiUrl: plan.apiUrl,
      deployment: plan.deployment,
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      platformVersion: version,
      publicEndpoints: !preserveDisabled,
      proxyUrl: plan.proxyUrl,
      resources: {
        hyperdrive: requireId(ids, 'hyperdrive'),
        isrCacheKv: requireId(ids, 'isr-cache-kv'),
        legacyAssetsKv: requireId(ids, 'legacy-assets-kv'),
        routingKv: requireId(ids, 'routing-kv'),
        zone: zone.id,
      },
      runtimeEntrypoints: entrypoints,
    });
    const deployWorker = dependencies.deployWorker ?? deployPlatformWorker;
    for (const key of ['api', 'proxy', 'tail', 'dispatch'] as const) {
      const action = plan.actions.find((entry) => entry.key === `${key}-worker`)!;
      const workerSecrets =
        key === 'api'
          ? apiWorkerSecrets(secrets, plan.account.id, zone.id)
          : key === 'proxy'
            ? proxyWorkerSecrets(secrets, plan.account.id)
            : null;
      manifest = recordProvisionIntent(manifest, action, now());
      writeInstallationManifest(manifest);
      await deployWorker(configs[key], workerSecrets);
      manifest = recordResource(manifest, action, action.name, 'created', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }

    manifest = setInstallationEndpoints(
      manifest,
      { apiUrl: plan.apiUrl, dashboardUrl: null, proxyUrl: plan.proxyUrl },
      now(),
    );
    if (preserveDisabled) {
      manifest = transitionInstallation(manifest, 'disabled', now());
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      promoteInstallationSecrets(manifest);
      saveInstalledPlatformConnection(plan, manifest);
      return { manifest, waitingForDns: false, zoneNameServers: zone.nameServers };
    }
    manifest = transitionInstallation(manifest, 'verifying', now());
    writeInstallationManifest(manifest);
    await (dependencies.verifyHealth ?? verifyPlatformHealth)(plan.apiUrl, manifest.id);
    manifest = transitionInstallation(manifest, 'installed', now());
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    promoteInstallationSecrets(manifest);
    saveInstalledPlatformConnection(plan, manifest);
    return { manifest, waitingForDns: false, zoneNameServers: zone.nameServers };
  } catch (error) {
    if (manifest.status !== 'failed' && manifest.status !== 'uninstalled') {
      try {
        manifest = transitionInstallation(manifest, 'failed', now());
        writeInstallationManifest(manifest);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      } catch {
        // Preserve the original failure when a terminal state cannot transition.
      }
    }
    throw error;
  }
}

async function writeR2OwnershipMarkerIfNeeded(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): Promise<void> {
  if (action.kind !== 'r2-bucket') {
    return;
  }
  const bucket = manifest.resources.find(
    (resource) => resource.key === action.key && resource.state === 'ready',
  );
  if (!bucket || bucket.ownership !== 'created') {
    return;
  }
  await client.putR2Object(
    plan.account.id,
    bucket.name,
    PLATFORM_R2_OWNERSHIP_MARKER_KEY,
    JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: plan.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: bucket.id,
        resourceKey: bucket.key,
        resourceKind: bucket.kind,
        resourceName: bucket.name,
      }),
    ),
  );
}

function saveInstalledPlatformConnection(
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
): void {
  savePlatformConnection({
    accountId: plan.account.id,
    apiUrl: plan.apiUrl,
    applicationDomain: plan.deployment.application.baseDomain,
    displayName: plan.deployment.displayName,
    installationId: manifest.id,
    kind: 'installed',
    proxyUrl: plan.proxyUrl,
  });
}

async function writeRemoteInstallationCheckpoint(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
): Promise<void> {
  const routing = manifest.resources.find(
    (resource) =>
      resource.key === 'routing-kv' &&
      resource.kind === 'kv-namespace' &&
      resource.ownership === 'created' &&
      resource.state === 'ready',
  );
  if (!routing) {
    return;
  }
  await client.putKvValue(
    plan.account.id,
    routing.id,
    REMOTE_INSTALLATION_MANIFEST_KEY,
    JSON.stringify(manifest),
  );
}

function recordProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  now: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `provision-intent:${action.key}`,
      resultHash: platformProvisionIntentHash(manifest, action.key, action.kind, action.name),
    },
    now,
  );
}

function hasProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): boolean {
  return manifest.steps.some(
    (step) =>
      step.key === `provision-intent:${action.key}` &&
      step.resultHash ===
        platformProvisionIntentHash(manifest, action.key, action.kind, action.name),
  );
}

async function createResource(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  action: PlatformInstallPlanAction,
  databaseUrl: string,
  zoneId: string,
): Promise<{ id: string; name: string }> {
  switch (action.kind) {
    case 'ai-gateway':
      return client.createAiGateway(plan.account.id, action.name);
    case 'dns-record':
      return client.createDnsRecord(zoneId, action.name);
    case 'kv-namespace':
      return client.createKvNamespace(plan.account.id, action.name);
    case 'r2-bucket':
      return client.createR2Bucket(plan.account.id, action.name);
    case 'queue':
      return client.createQueue(plan.account.id, action.name);
    case 'dispatch-namespace':
      return client.createDispatchNamespace(plan.account.id, action.name);
    case 'hyperdrive':
      return client.createHyperdrive(plan.account.id, action.name, databaseUrl);
    default:
      throw new Error(`platform: Cannot provision ${action.kind} in the resource phase.`);
  }
}

function recordResource(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  id: string,
  ownership: InstallationResource['ownership'] | undefined,
  now: string,
): PlatformInstallationManifest {
  const previous = manifest.resources.find((resource) => resource.key === action.key);
  return recordInstallationResource(
    manifest,
    {
      configHash: hash(JSON.stringify({ kind: action.kind, name: action.name })),
      id,
      key: action.key,
      kind: action.kind,
      name: action.name,
      ownership: ownership ?? previous?.ownership ?? 'created',
      state: 'ready',
    },
    now,
  );
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireId(ids: Record<string, string>, key: string): string {
  const id = ids[key];
  if (!id) {
    throw new Error(`platform: Installation manifest is missing ${key}.`);
  }
  return id;
}

function apiWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
  zoneId: string,
): Record<string, string> {
  return {
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    CF_ZONE_ID: zoneId,
    GITHUB_CLIENT_ID: secrets.githubClientId,
    GITHUB_CLIENT_SECRET: secrets.githubClientSecret,
    JWT_SECRET: secrets.jwtSecret,
    PLATFORM_BOOTSTRAP_GITHUB_ID: secrets.bootstrapGitHubId,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: 'v1',
    PROJECT_SECRET_KEYS_JSON: JSON.stringify({ v1: secrets.projectSecretKey }),
    R2_ACCESS_KEY_ID: secrets.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: secrets.r2SecretAccessKey,
  };
}

export async function resolveBootstrapGitHubId(
  login: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const normalizedLogin = login.trim();
  if (!normalizedLogin) {
    throw new Error('platform: VOID_PLATFORM_ADMIN_GITHUB_LOGIN is required.');
  }
  const response = await fetcher(
    `https://api.github.com/users/${encodeURIComponent(normalizedLogin)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'void-platform-installer',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `platform: Could not resolve GitHub user ${JSON.stringify(normalizedLogin)} (HTTP ${response.status}). Verify the username and retry.`,
    );
  }
  const body = (await response.json()) as { id?: unknown };
  const id = typeof body.id === 'number' && Number.isSafeInteger(body.id) ? String(body.id) : '';
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new Error(
      'platform: GitHub returned an invalid account id for the initial administrator.',
    );
  }
  return id;
}

function proxyWorkerSecrets(
  secrets: PlatformInstallationSecrets,
  accountId: string,
): Record<string, string> {
  return {
    CF_ACCOUNT_ID: accountId,
    CF_API_TOKEN: secrets.cloudflareApiToken,
    JWT_SECRET: secrets.jwtSecret,
  };
}

async function migratePlatformDatabase(
  databaseUrl: string,
  migrationsFolder: string,
): Promise<void> {
  const [{ Pool }, { drizzle }, { migrate }] = await Promise.all([
    import('pg'),
    import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'),
  ]);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

async function deployPlatformWorker(
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-deploy-'));
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const argv = ['deploy', '--config', configPath, '--strict'];
    if (secrets) {
      const secretsPath = join(directory, 'secrets.json');
      writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
      argv.push('--secrets-file', secretsPath);
    }
    const [command, ...prefix] = resolveWranglerArgv(process.cwd());
    const result = spawnSync(command, [...prefix, ...argv], {
      cwd: directory,
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: String(config.account_id),
        CLOUDFLARE_API_TOKEN:
          process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || undefined,
      },
      stdio: 'inherit',
      timeout: 10 * 60 * 1000,
    });
    if (result.status !== 0) {
      throw new Error(
        `platform: Wrangler failed to deploy ${String(config.name)} (${result.signal ?? result.status ?? 'unknown failure'}).`,
      );
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function verifyRuntimeArtifacts(runtimeDirectory: string): void {
  const manifest = readPlatformRuntimeManifest();
  for (const artifact of Object.values(manifest.artifacts)) {
    const path = join(runtimeDirectory, artifact.path);
    const contents = readFileSync(path);
    if (contents.byteLength !== artifact.size || hash(contents) !== artifact.sha256) {
      throw new Error(`platform: Packaged Worker artifact failed integrity verification: ${path}.`);
    }
  }
}

async function verifyPlatformHealth(apiUrl: string, installationId: string): Promise<void> {
  const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(30_000) });
  if (!health.ok) {
    throw new Error(`platform: Health check failed at ${apiUrl} (HTTP ${health.status}).`);
  }
  const discovery = await fetch(`${apiUrl}/.well-known/void-platform`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!discovery.ok) {
    throw new Error(`platform: Discovery check failed at ${apiUrl} (HTTP ${discovery.status}).`);
  }
  const body = (await discovery.json()) as { installationId?: unknown };
  if (body.installationId !== installationId) {
    throw new Error('platform: Deployed API discovery identity does not match this installation.');
  }
}
