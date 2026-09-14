import { parsePlatformDeploymentManifest, type PlatformDeploymentManifest } from './manifest.ts';

export const PLATFORM_INSTALLATION_SCHEMA_VERSION = 1 as const;

export type InstallationStatus =
  | 'draft'
  | 'planned'
  | 'provisioning'
  | 'waiting-for-dns'
  | 'waiting-for-oauth'
  | 'deploying'
  | 'verifying'
  | 'installed'
  | 'disabling'
  | 'disabled'
  | 'uninstalling'
  | 'uninstalled'
  | 'failed';

export type ResourceOwnership = 'created' | 'adopted' | 'external';

export type InstallationResourceKind =
  | 'ai-gateway'
  | 'analytics-dataset'
  | 'dispatch-namespace'
  | 'dns-record'
  | 'hyperdrive'
  | 'kv-namespace'
  | 'queue'
  | 'r2-bucket'
  | 'worker'
  | 'worker-custom-domain'
  | 'worker-route'
  | 'zone';

export type InstallationResource = Readonly<{
  configHash: string;
  id: string;
  key: string;
  kind: InstallationResourceKind;
  name: string;
  ownership: ResourceOwnership;
  state: 'ready' | 'retained' | 'deleted';
}>;

export type InstallationStep = Readonly<{
  completedAt: string;
  key: string;
  resultHash: string;
}>;

export type PlatformInstallationEndpoints = Readonly<{
  apiUrl: string | null;
  dashboardUrl: string | null;
  proxyUrl: string | null;
}>;

export type PlatformInstallationManifest = Readonly<{
  account: Readonly<{
    id: string;
    name: string;
  }>;
  createdAt: string;
  deployment: PlatformDeploymentManifest;
  endpoints: PlatformInstallationEndpoints;
  id: string;
  ownershipNonce: string;
  platformVersion: string;
  resources: ReadonlyArray<InstallationResource>;
  schemaVersion: typeof PLATFORM_INSTALLATION_SCHEMA_VERSION;
  status: InstallationStatus;
  steps: ReadonlyArray<InstallationStep>;
  updatedAt: string;
}>;

const STATUS_TRANSITIONS: Readonly<Record<InstallationStatus, ReadonlyArray<InstallationStatus>>> =
  {
    draft: ['planned', 'failed', 'uninstalling'],
    planned: ['provisioning', 'failed', 'uninstalling'],
    provisioning: ['waiting-for-dns', 'waiting-for-oauth', 'deploying', 'failed', 'uninstalling'],
    'waiting-for-dns': ['provisioning', 'failed', 'uninstalling'],
    'waiting-for-oauth': ['provisioning', 'deploying', 'failed', 'uninstalling'],
    deploying: ['verifying', 'failed', 'uninstalling'],
    verifying: ['installed', 'failed', 'uninstalling'],
    installed: ['provisioning', 'disabling', 'uninstalling', 'failed'],
    disabling: ['disabled', 'failed'],
    disabled: ['provisioning', 'uninstalling', 'failed'],
    uninstalling: ['uninstalled', 'failed'],
    uninstalled: [],
    failed: ['planned', 'provisioning', 'deploying', 'verifying', 'disabling', 'uninstalling'],
  };

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function isInstallationStatus(value: unknown): value is InstallationStatus {
  return typeof value === 'string' && Object.hasOwn(STATUS_TRANSITIONS, value);
}

function isResourceKind(value: unknown): value is InstallationResourceKind {
  return (
    value === 'ai-gateway' ||
    value === 'analytics-dataset' ||
    value === 'dispatch-namespace' ||
    value === 'dns-record' ||
    value === 'hyperdrive' ||
    value === 'kv-namespace' ||
    value === 'queue' ||
    value === 'r2-bucket' ||
    value === 'worker' ||
    value === 'worker-custom-domain' ||
    value === 'worker-route' ||
    value === 'zone'
  );
}

function isOwnership(value: unknown): value is ResourceOwnership {
  return value === 'created' || value === 'adopted' || value === 'external';
}

function isResourceState(value: unknown): value is InstallationResource['state'] {
  return value === 'ready' || value === 'retained' || value === 'deleted';
}

function assertTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}

export function createPlatformInstallationManifest(input: {
  account: { id: string; name: string };
  createdAt: string;
  deployment: PlatformDeploymentManifest;
  id: string;
  ownershipNonce: string;
  platformVersion: string;
}): PlatformInstallationManifest {
  const createdAt = assertTimestamp(input.createdAt, 'createdAt');
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/.test(input.id)) {
    throw new Error('Installation id must be a lowercase identifier between 8 and 80 characters.');
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.ownershipNonce)) {
    throw new Error('Ownership nonce must contain 32 to 128 URL-safe characters.');
  }
  return {
    account: {
      id: requiredString(input.account.id, 'account.id'),
      name: requiredString(input.account.name, 'account.name'),
    },
    createdAt,
    deployment: parsePlatformDeploymentManifest(
      JSON.parse(JSON.stringify(input.deployment)) as unknown,
    ),
    endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
    id: input.id,
    ownershipNonce: input.ownershipNonce,
    platformVersion: requiredString(input.platformVersion, 'platformVersion'),
    resources: [],
    schemaVersion: PLATFORM_INSTALLATION_SCHEMA_VERSION,
    status: 'draft',
    steps: [],
    updatedAt: createdAt,
  };
}

function normalizeEndpoint(value: string | null, label: string): string | null {
  if (value === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL or null.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

export function setInstallationEndpoints(
  manifest: PlatformInstallationManifest,
  endpoints: PlatformInstallationEndpoints,
  updatedAt: string,
): PlatformInstallationManifest {
  return {
    ...manifest,
    endpoints: {
      apiUrl: normalizeEndpoint(endpoints.apiUrl, 'endpoints.apiUrl'),
      dashboardUrl: normalizeEndpoint(endpoints.dashboardUrl, 'endpoints.dashboardUrl'),
      proxyUrl: normalizeEndpoint(endpoints.proxyUrl, 'endpoints.proxyUrl'),
    },
    updatedAt: assertTimestamp(updatedAt, 'updatedAt'),
  };
}

export function transitionInstallation(
  manifest: PlatformInstallationManifest,
  status: InstallationStatus,
  updatedAt: string,
): PlatformInstallationManifest {
  if (status !== manifest.status && !STATUS_TRANSITIONS[manifest.status].includes(status)) {
    throw new Error(`Invalid installation transition: ${manifest.status} -> ${status}.`);
  }
  return { ...manifest, status, updatedAt: assertTimestamp(updatedAt, 'updatedAt') };
}

export function recordInstallationResource(
  manifest: PlatformInstallationManifest,
  resource: InstallationResource,
  updatedAt: string,
): PlatformInstallationManifest {
  requiredString(resource.key, 'resource.key');
  requiredString(resource.id, 'resource.id');
  requiredString(resource.name, 'resource.name');
  requiredString(resource.configHash, 'resource.configHash');
  const collision = manifest.resources.find(
    (entry) =>
      entry.key !== resource.key && entry.kind === resource.kind && entry.id === resource.id,
  );
  if (collision) {
    throw new Error(`Resource id ${resource.id} is already owned by ${collision.key}.`);
  }
  const resources = manifest.resources.filter((entry) => entry.key !== resource.key);
  resources.push({ ...resource });
  resources.sort((left, right) => left.key.localeCompare(right.key));
  return { ...manifest, resources, updatedAt: assertTimestamp(updatedAt, 'updatedAt') };
}

export function recordInstallationStep(
  manifest: PlatformInstallationManifest,
  step: InstallationStep,
  updatedAt: string,
): PlatformInstallationManifest {
  requiredString(step.key, 'step.key');
  requiredString(step.resultHash, 'step.resultHash');
  assertTimestamp(step.completedAt, 'step.completedAt');
  const existing = manifest.steps.find((entry) => entry.key === step.key);
  if (existing && existing.resultHash !== step.resultHash) {
    throw new Error(`Completed installation step ${step.key} has a different result.`);
  }
  const steps = existing ? manifest.steps : [...manifest.steps, { ...step }];
  return { ...manifest, steps, updatedAt: assertTimestamp(updatedAt, 'updatedAt') };
}

export function parsePlatformInstallationManifest(value: unknown): PlatformInstallationManifest {
  assertRecord(value, 'Platform installation manifest');
  if (value.schemaVersion !== PLATFORM_INSTALLATION_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported platform installation schema version: ${String(value.schemaVersion)}.`,
    );
  }
  const account = value.account;
  const endpoints = value.endpoints;
  assertRecord(account, 'account');
  assertRecord(endpoints, 'endpoints');
  if (!isInstallationStatus(value.status)) {
    throw new Error(`Invalid installation status: ${String(value.status)}.`);
  }
  if (!Array.isArray(value.resources)) {
    throw new Error('resources must be an array.');
  }
  if (!Array.isArray(value.steps)) {
    throw new Error('steps must be an array.');
  }
  const manifest = createPlatformInstallationManifest({
    account: {
      id: requiredString(account.id, 'account.id'),
      name: requiredString(account.name, 'account.name'),
    },
    createdAt: requiredString(value.createdAt, 'createdAt'),
    deployment: parsePlatformDeploymentManifest(value.deployment),
    id: requiredString(value.id, 'id'),
    ownershipNonce: requiredString(value.ownershipNonce, 'ownershipNonce'),
    platformVersion: requiredString(value.platformVersion, 'platformVersion'),
  });
  const updatedAt = assertTimestamp(requiredString(value.updatedAt, 'updatedAt'), 'updatedAt');
  let next: PlatformInstallationManifest = setInstallationEndpoints(
    { ...manifest, status: value.status, updatedAt },
    {
      apiUrl:
        endpoints.apiUrl === null ? null : requiredString(endpoints.apiUrl, 'endpoints.apiUrl'),
      dashboardUrl:
        endpoints.dashboardUrl === null
          ? null
          : requiredString(endpoints.dashboardUrl, 'endpoints.dashboardUrl'),
      proxyUrl:
        endpoints.proxyUrl === null
          ? null
          : requiredString(endpoints.proxyUrl, 'endpoints.proxyUrl'),
    },
    updatedAt,
  );
  for (const [index, entry] of value.resources.entries()) {
    assertRecord(entry, `resources[${index}]`);
    if (!isResourceKind(entry.kind)) {
      throw new Error(`Invalid resources[${index}].kind.`);
    }
    if (!isOwnership(entry.ownership)) {
      throw new Error(`Invalid resources[${index}].ownership.`);
    }
    if (!isResourceState(entry.state)) {
      throw new Error(`Invalid resources[${index}].state.`);
    }
    next = recordInstallationResource(
      next,
      {
        configHash: requiredString(entry.configHash, `resources[${index}].configHash`),
        id: requiredString(entry.id, `resources[${index}].id`),
        key: requiredString(entry.key, `resources[${index}].key`),
        kind: entry.kind,
        name: requiredString(entry.name, `resources[${index}].name`),
        ownership: entry.ownership,
        state: entry.state,
      },
      next.updatedAt,
    );
  }
  for (const [index, entry] of value.steps.entries()) {
    assertRecord(entry, `steps[${index}]`);
    next = recordInstallationStep(
      next,
      {
        completedAt: requiredString(entry.completedAt, `steps[${index}].completedAt`),
        key: requiredString(entry.key, `steps[${index}].key`),
        resultHash: requiredString(entry.resultHash, `steps[${index}].resultHash`),
      },
      next.updatedAt,
    );
  }
  return { ...next, updatedAt };
}
