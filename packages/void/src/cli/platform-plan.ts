import { createHash } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  type InstallationResourceKind,
  type PlatformDeploymentManifest,
  type PlatformInstallationManifest,
} from '@void/platform';
import type {
  CloudflareAccount,
  CloudflareNamedResource,
  CloudflareZone,
  PlatformCloudflareClient,
} from './platform-cloudflare.ts';

export type PlatformInstallPlanAction = Readonly<{
  action: 'adopt' | 'create' | 'reuse' | 'update';
  id: string | null;
  key: string;
  kind: InstallationResourceKind;
  name: string;
  reason: string;
}>;

export type PlatformInstallPlan = Readonly<{
  account: CloudflareAccount;
  actions: ReadonlyArray<PlatformInstallPlanAction>;
  apiUrl: string;
  deployment: PlatformDeploymentManifest;
  workersSubdomain: string;
  zone: CloudflareZone | null;
}>;

export type PlatformInstallPlanInput = Readonly<{
  accountId: string;
  applicationDomain: string;
  controlPlaneDomain: string;
  dedicatedZone: boolean;
  displayName: string;
  installationSlug: string;
  zoneName: string;
}>;

type PlanningClient = Pick<
  PlatformCloudflareClient,
  | 'findZone'
  | 'getWorkersSubdomain'
  | 'listAccounts'
  | 'listDispatchNamespaces'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'verifyToken'
>;

export async function createPlatformInstallPlan(
  client: PlanningClient,
  input: PlatformInstallPlanInput,
  existing: PlatformInstallationManifest | null,
): Promise<PlatformInstallPlan> {
  await client.verifyToken();
  const accounts = await client.listAccounts();
  const account = resolveAccount(accounts, input.accountId);
  if (existing && existing.account.id !== account.id) {
    throw new Error(
      `platform: Refusing to resume installation ${existing.id} in a different Cloudflare account.`,
    );
  }
  const deployment = createPlatformDeploymentManifest({
    application: {
      baseDomain: input.applicationDomain,
      dedicatedZone: input.dedicatedZone,
      zoneName: input.zoneName,
    },
    controlPlane: {
      apiHostname: input.controlPlaneDomain || null,
      dashboardHostname: null,
      proxyHostname: null,
    },
    displayName: input.displayName,
    installationSlug: input.installationSlug,
  });
  if (existing && JSON.stringify(existing.deployment) !== JSON.stringify(deployment)) {
    throw new Error(
      `platform: --resume inputs do not match installation ${existing.id}. Use its recorded configuration.`,
    );
  }

  const names = deployment.resources;
  const [
    workersSubdomain,
    zone,
    routingKv,
    isrKv,
    legacyKv,
    r2Buckets,
    usageQueues,
    cronQueues,
    dispatchNamespaces,
    hyperdrives,
    workers,
  ] = await Promise.all([
    client.getWorkersSubdomain(account.id),
    client.findZone(account.id, deployment.application.zoneName),
    client.listKvNamespaces(account.id, names.routingKv),
    client.listKvNamespaces(account.id, names.isrCacheKv),
    client.listKvNamespaces(account.id, names.legacyAssetsKv),
    client.listR2Buckets(account.id),
    client.listQueues(account.id, names.usageQueue),
    client.listQueues(account.id, names.cronQueue),
    client.listDispatchNamespaces(account.id),
    client.listHyperdriveConfigs(account.id),
    client.listWorkerNames(account.id),
  ]);
  const actions: Array<PlatformInstallPlanAction> = [];
  const recordedZone = existing?.resources.find((resource) => resource.key === 'zone');
  const intendedZone = existing
    ? hasProvisionIntent(existing, 'zone', 'zone', deployment.application.zoneName)
    : false;
  if (recordedZone && (!zone || recordedZone.id !== zone.id || recordedZone.kind !== 'zone')) {
    throw new Error(
      `platform: Recorded zone ${recordedZone.name} (${recordedZone.id}) no longer matches the Cloudflare account.`,
    );
  }
  actions.push({
    action: recordedZone || (zone && intendedZone) ? 'reuse' : zone ? 'adopt' : 'create',
    id: zone?.id ?? null,
    key: 'zone',
    kind: 'zone',
    name: deployment.application.zoneName,
    reason:
      recordedZone || intendedZone
        ? 'Reuse the recorded zone.'
        : zone
          ? 'Use the existing zone without taking ownership.'
          : 'Create the requested zone.',
  });
  addNamedPlan(actions, existing, 'routing-kv', 'kv-namespace', names.routingKv, routingKv);
  addNamedPlan(actions, existing, 'isr-cache-kv', 'kv-namespace', names.isrCacheKv, isrKv);
  addNamedPlan(
    actions,
    existing,
    'legacy-assets-kv',
    'kv-namespace',
    names.legacyAssetsKv,
    legacyKv,
  );
  addNamedPlan(
    actions,
    existing,
    'assets-bucket',
    'r2-bucket',
    names.assetsBucket,
    r2Buckets.filter((resource) => resource.name === names.assetsBucket),
  );
  addNamedPlan(actions, existing, 'usage-queue', 'queue', names.usageQueue, usageQueues);
  addNamedPlan(actions, existing, 'cron-queue', 'queue', names.cronQueue, cronQueues);
  addNamedPlan(
    actions,
    existing,
    'dispatch-namespace',
    'dispatch-namespace',
    names.dispatchNamespace,
    dispatchNamespaces.filter((resource) => resource.name === names.dispatchNamespace),
  );
  addNamedPlan(
    actions,
    existing,
    'hyperdrive',
    'hyperdrive',
    names.hyperdrive,
    hyperdrives.filter((resource) => resource.name === names.hyperdrive),
  );
  for (const [key, name] of [
    ['api-worker', names.apiWorker],
    ['proxy-worker', names.proxyWorker],
    ['tail-worker', names.tailWorker],
    ['dispatch-worker', names.dispatchWorker],
  ] as const) {
    const matches = workers.includes(name) ? [{ id: name, name }] : [];
    addNamedPlan(actions, existing, key, 'worker', name, matches, 'update');
  }
  const apiUrl = deployment.controlPlane.apiHostname
    ? `https://${deployment.controlPlane.apiHostname}`
    : `https://${names.apiWorker}.${workersSubdomain}.workers.dev`;
  return { account, actions, apiUrl, deployment, workersSubdomain, zone };
}

function resolveAccount(
  accounts: ReadonlyArray<CloudflareAccount>,
  selector: string,
): CloudflareAccount {
  const matches = selector
    ? accounts.filter(
        (account) =>
          account.id === selector || account.name.toLowerCase() === selector.toLowerCase(),
      )
    : accounts;
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `platform: Cloudflare account ${JSON.stringify(selector)} is not available to this token.`
        : 'platform: Select a Cloudflare account with --account <id>.',
    );
  }
  return matches[0]!;
}

function addNamedPlan(
  actions: Array<PlatformInstallPlanAction>,
  existing: PlatformInstallationManifest | null,
  key: string,
  kind: InstallationResourceKind,
  name: string,
  matches: ReadonlyArray<CloudflareNamedResource>,
  existingAction: 'reuse' | 'update' = 'reuse',
): void {
  if (matches.length > 1) {
    throw new Error(`platform: More than one ${kind} named ${JSON.stringify(name)} exists.`);
  }
  const remote = matches[0];
  const recorded = existing?.resources.find((resource) => resource.key === key);
  if (remote) {
    const intended = existing ? hasProvisionIntent(existing, key, kind, name) : false;
    if ((!recorded || recorded.id !== remote.id || recorded.kind !== kind) && !intended) {
      throw new Error(
        `platform: ${kind} ${JSON.stringify(name)} already exists but is not owned by this installation. Choose another installation name.`,
      );
    }
    actions.push({
      action: existingAction,
      id: remote.id,
      key,
      kind,
      name,
      reason:
        existingAction === 'update'
          ? 'Deploy the current platform version.'
          : 'Reuse the recorded resource.',
    });
    return;
  }
  if (recorded && recorded.state === 'ready') {
    throw new Error(
      `platform: Recorded ${kind} ${JSON.stringify(name)} (${recorded.id}) is missing. Run \`void platform repair ${existing!.id}\` to reconcile it.`,
    );
  }
  actions.push({
    action: 'create',
    id: null,
    key,
    kind,
    name,
    reason: `Create an installer-owned ${kind}.`,
  });
}

export function platformProvisionIntentHash(
  manifest: Pick<PlatformInstallationManifest, 'ownershipNonce'>,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ key, kind, name, ownershipNonce: manifest.ownershipNonce }))
    .digest('hex');
}

function hasProvisionIntent(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): boolean {
  const intent = manifest.steps.find((step) => step.key === `provision-intent:${key}`);
  return intent?.resultHash === platformProvisionIntentHash(manifest, key, kind, name);
}

export function formatPlatformInstallPlan(plan: PlatformInstallPlan): string {
  const lines = [
    `${plan.deployment.displayName} in ${plan.account.name} (${plan.account.id})`,
    `Applications: *.${plan.deployment.application.baseDomain}`,
    `Control plane: ${plan.apiUrl}`,
    '',
  ];
  for (const action of plan.actions) {
    lines.push(`${action.action.padEnd(6)} ${action.kind.padEnd(19)} ${action.name}`);
  }
  return lines.join('\n');
}
