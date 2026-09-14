import { randomBytes } from 'node:crypto';
import { confirm, intro, isCancel, log, note, outro, password, select, text } from '@clack/prompts';
import {
  normalizeApplicationDomain,
  normalizeInstallationSlug,
  type PlatformInstallationManifest,
} from '@void/platform';
import { cliTitle } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import { PlatformCloudflareClient, type CloudflareAccount } from './platform-cloudflare.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  createPlatformInstallationSecrets,
  installPlatform,
  readPlatformDatabaseLifecycleManifest,
  resolveBootstrapGitHubId,
} from './platform-installer.ts';
import {
  createPlatformInstallPlan,
  formatPlatformInstallPlan,
  revalidatePlatformInstallAction,
} from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  assertPlatformInstallationSlugAvailable,
  readPendingInstallationSecrets,
  resolveInstallationManifest,
  writeInstallationManifest,
} from './platform-registry.ts';

export function resolvePlatformInstallDatabaseUrl(
  checkpoint: Record<string, string> | null,
  manifest: PlatformInstallationManifest | null = null,
): string {
  const explicit = process.env.VOID_PLATFORM_DATABASE_URL || process.env.DATABASE_URL || '';
  const recorded = checkpoint?.databaseUrl || '';
  const databaseBound =
    checkpoint?.databaseClaimState === 'claimed' ||
    manifest?.resources.some(
      (resource) =>
        resource.state === 'ready' &&
        (resource.kind === 'hyperdrive' || resource.kind === 'worker'),
    ) ||
    manifest?.steps.some(
      (step) =>
        step.key.startsWith('database-schema:') || step.key.startsWith('database-migrations:'),
    );
  if (databaseBound) {
    if (!recorded) {
      if (explicit) {
        // Discovery intentionally recovers no credentials. The database's
        // installation claim and ownership nonce are verified under the
        // advisory lock before any lifecycle mutation, and the live
        // Hyperdrive origin is checked against this URL before redeployment.
        return explicit;
      }
      throw new Error(
        'platform: The claimed PostgreSQL database URL is missing from local recovery state. Export VOID_PLATFORM_DATABASE_URL with the original installation database before continuing.',
      );
    }
    if (explicit && explicit !== recorded) {
      throw new Error(
        'platform: This installation is already bound to its recorded PostgreSQL database. Unset DATABASE_URL and VOID_PLATFORM_DATABASE_URL before resuming; changing databases requires an explicit migration flow.',
      );
    }
    return recorded;
  }
  // A failed initial claim has no Cloudflare resource bound to the database,
  // so explicit operator input may correct an unreachable or mistyped URL.
  return explicit || recorded;
}

export async function runPlatformLifecycleCommand(args: PlatformArgs): Promise<void> {
  if (args.subcommand === 'discover') {
    const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
    if (!token) {
      throw new Error('platform: Export CLOUDFLARE_API_TOKEN before discovering installations.');
    }
    const client = new PlatformCloudflareClient(token);
    const accounts = await readAccounts(client);
    const accountId = await selectAccount(accounts, args.account);
    const { recoverPlatformInstallations } = await import('./platform-recovery.ts');
    const recovered = await recoverPlatformInstallations(client, accountId);
    if (recovered.length === 0) {
      log.info(`No recoverable Void platform installations were found in ${accountId}.`);
      return;
    }
    for (const manifest of recovered) {
      log.success(
        `Recovered ${manifest.deployment.displayName} (${manifest.id}) at ${manifest.endpoints.apiUrl}.`,
      );
    }
    return;
  }
  if (args.subcommand !== 'install') {
    const { runInstalledPlatformCommand } = await import('./platform-management.ts');
    await runInstalledPlatformCommand(args);
    return;
  }

  assertNoninteractivePlatformMutationAcknowledged(args, process.stdin.isTTY === true);

  console.log();
  intro(cliTitle('platform install'));
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
  if (!token) {
    throw new Error(
      'platform: Export CLOUDFLARE_API_TOKEN before installing. This token is also stored as an encrypted Worker secret so the platform can provision app resources.',
    );
  }
  const client = new PlatformCloudflareClient(token);
  let existing = args.resume ? resolveInstallationManifest(args.name) : null;
  if (existing?.endpoints.apiUrl && !readPendingInstallationSecrets(existing)) {
    throw new Error(
      `platform: Installation ${existing.id} has already been deployed. Use \`void platform repair ${existing.id}\` or \`void platform upgrade ${existing.id}\` instead.`,
    );
  }
  const recorded = existing?.deployment;
  const name =
    recorded?.installationSlug ??
    (args.name || (await promptText('Installation name:', 'company')));
  const installationSlug = normalizeInstallationSlug(name);
  if (!existing) {
    assertPlatformInstallationSlugAvailable(installationSlug);
  }
  const accounts = await readAccounts(client);
  const accountId = recorded ? existing!.account.id : await selectAccount(accounts, args.account);
  const applicationDomain =
    recorded?.application.baseDomain ??
    normalizeApplicationDomain(
      args.applicationDomain || (await promptText('Application base domain:', 'apps.example.com')),
    );
  const zoneName =
    recorded?.application.zoneName ??
    normalizeApplicationDomain(
      args.zone || (await promptText('Cloudflare zone:', applicationDomain)),
    );
  const displayName =
    recorded?.displayName ??
    (args.displayName || (await promptText('Platform display name:', `${installationSlug} Void`)));
  const controlPlaneDomain =
    recorded?.controlPlane.apiHostname ??
    (args.controlPlaneDomain ||
      (process.stdin.isTTY
        ? await promptText('Optional custom API hostname (leave empty for workers.dev):', '', true)
        : ''));
  let dedicatedZone = recorded?.application.dedicatedZone ?? args.dedicatedZone;
  if (!recorded && !args.dedicatedZone && applicationDomain === zoneName && process.stdin.isTTY) {
    const catchAll = await confirm({
      message: `Dedicate all unmatched ${zoneName} traffic to Void apps?`,
      initialValue: false,
    });
    if (isCancel(catchAll) || typeof catchAll === 'symbol') {
      throw new Error('platform: Cancelled.');
    }
    dedicatedZone = catchAll;
  }
  const release = args.plan ? null : acquirePlatformLifecycleLock(accountId, installationSlug);
  try {
    if (!existing && !args.plan) {
      assertPlatformInstallationSlugAvailable(installationSlug);
    }
    if (existing && !args.plan) {
      existing = resolveInstallationManifest(existing.id);
    }
    const checkpoint = existing ? readPendingInstallationSecrets(existing) : null;
    const databaseUrl = resolvePlatformInstallDatabaseUrl(checkpoint, existing);
    let authoritativeProvisionIntents = false;
    if (existing) {
      if (!databaseUrl) {
        throw new Error(
          'platform: DATABASE_URL is required to verify an interrupted installation before resuming it.',
        );
      }
      const authoritative = await readPlatformDatabaseLifecycleManifest(
        databaseUrl,
        existing.id,
        existing.ownershipNonce,
      );
      if (authoritative) {
        const { selectAuthoritativePlatformManifest } = await import('./platform-management.ts');
        const selected = selectAuthoritativePlatformManifest(existing, authoritative);
        authoritativeProvisionIntents = true;
        if (!args.plan && JSON.stringify(selected) !== JSON.stringify(existing)) {
          writeInstallationManifest(selected);
        }
        existing = selected;
      }
    }
    const planInput = {
      accountId,
      applicationDomain,
      controlPlaneDomain,
      dedicatedZone,
      displayName,
      installationSlug,
      zoneName,
    };
    const plan = await createInitialPlatformInstallPlan(
      client,
      planInput,
      existing,
      authoritativeProvisionIntents,
      args.plan,
    );
    note(
      formatPlatformInstallPlan(plan),
      args.plan ? 'Read-only installation plan' : 'Installation plan',
    );
    if (args.plan) {
      outro('No Cloudflare or local installation state was changed.');
      return;
    }
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: 'Apply this plan?', initialValue: false });
      if (isCancel(proceed) || !proceed) {
        outro('No changes made.');
        return;
      }
    }

    note(
      `Create a GitHub OAuth App with this callback URL:\n${plan.apiUrl}/auth/callback\n\n` +
        'For direct asset uploads, create an R2 API token with Object Read & Write access to this account.',
      'Authentication setup',
    );
    const bootstrapGitHubLogin =
      checkpoint?.bootstrapGitHubLogin ||
      process.env.VOID_PLATFORM_ADMIN_GITHUB_LOGIN ||
      (await promptSecret('Initial administrator GitHub username:', false));
    const bootstrapGitHubId =
      checkpoint?.bootstrapGitHubId ||
      process.env.VOID_PLATFORM_ADMIN_GITHUB_ID ||
      (await resolveBootstrapGitHubId(bootstrapGitHubLogin));
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId,
      bootstrapGitHubLogin,
      cloudflareApiToken: token,
      checkpoint,
      databaseUrl: databaseUrl || (await promptSecret('PostgreSQL DATABASE_URL:')),
      githubClientId:
        checkpoint?.githubClientId ||
        process.env.VOID_PLATFORM_GITHUB_CLIENT_ID ||
        (await promptSecret('GitHub OAuth client ID:', false)),
      githubClientSecret:
        checkpoint?.githubClientSecret ||
        process.env.VOID_PLATFORM_GITHUB_CLIENT_SECRET ||
        (await promptSecret('GitHub OAuth client secret:')),
      existingInstallation: existing !== null,
      jwtSecret: process.env.VOID_PLATFORM_JWT_SECRET || '',
      projectSecretKey: process.env.VOID_PLATFORM_PROJECT_SECRET_KEY || '',
      r2AccessKeyId:
        checkpoint?.r2AccessKeyId ||
        process.env.VOID_PLATFORM_R2_ACCESS_KEY_ID ||
        (await promptSecret('R2 access key ID:', false)),
      r2SecretAccessKey:
        checkpoint?.r2SecretAccessKey ||
        process.env.VOID_PLATFORM_R2_SECRET_ACCESS_KEY ||
        (await promptSecret('R2 secret access key:')),
    });
    const result = await installPlatform(plan, secrets, existing, {
      acquireDatabaseLifecycleLock: acquirePlatformDatabaseLifecycleLock,
      client,
      replanWorkers: async (manifest) =>
        (
          await createPlatformInstallPlan(client, planInput, manifest, {
            authoritativeProvisionIntents: true,
            repairMissing: true,
          })
        ).actions.filter((action) => action.kind === 'worker'),
      revalidateBeforeWorkerDeploy: (manifest, action) =>
        revalidatePlatformInstallAction(client, plan, manifest, action),
      verifyExistingOwnership: async (manifest, databaseCheckpointExists) => {
        const { verifyPlatformInstallationOwnership } = await import('./platform-management.ts');
        await verifyPlatformInstallationOwnership(client, manifest, {
          allowUninitializedRoutingCheckpoint: databaseCheckpointExists,
          databaseUrl: secrets.databaseUrl,
        });
      },
    });
    if (result.waitingForDns) {
      note(
        result.zoneNameServers.length > 0
          ? `Update the domain at your registrar to use:\n${result.zoneNameServers.join('\n')}\n\nThen rerun: void platform install --resume --name ${result.manifest.id}`
          : `Wait for ${zoneName} to become active, then rerun:\nvoid platform install --resume --name ${result.manifest.id}`,
        'Waiting for nameservers',
      );
      outro(`Installation ${result.manifest.id} is safely checkpointed.`);
      return;
    }
    log.success(`${result.manifest.deployment.displayName} is installed at ${plan.apiUrl}.`);
    outro('Run `void auth login`, then deploy an app with `void deploy --platform void`.');
  } finally {
    release?.();
  }
}

export function assertNoninteractivePlatformMutationAcknowledged(
  args: PlatformArgs,
  interactive: boolean,
): void {
  if (
    args.subcommand === 'connect' ||
    args.subcommand === 'list' ||
    args.subcommand === 'use' ||
    args.subcommand === 'status' ||
    args.subcommand === 'discover' ||
    args.plan ||
    interactive ||
    args.yes
  ) {
    return;
  }
  throw new Error(
    `platform: Non-interactive \`void platform ${args.subcommand}\` requires --yes to acknowledge Cloudflare changes. Run with --plan first to inspect them.`,
  );
}

async function createInitialPlatformInstallPlan(
  client: PlatformCloudflareClient,
  input: Parameters<typeof createPlatformInstallPlan>[1],
  existing: PlatformInstallationManifest | null,
  authoritativeProvisionIntents: boolean,
  planOnly: boolean,
): Promise<Awaited<ReturnType<typeof createPlatformInstallPlan>>> {
  if (existing || planOnly) {
    return createPlatformInstallPlan(client, input, existing, {
      authoritativeProvisionIntents,
    });
  }
  let collision: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await createPlatformInstallPlan(client, input, null, {
        authoritativeProvisionIntents,
        // A fresh apply receives a 128-bit resource namespace. Independent installers
        // therefore cannot accidentally choose the same Worker name during the API's
        // non-atomic create precondition window; installers resuming the SAME installation
        // are serialized by the PostgreSQL lifecycle lock. An account principal deliberately
        // targeting this exact random name already has authority to replace it after install.
        provisioningSuffix: randomBytes(16).toString('hex'),
      });
    } catch (error) {
      if (!String(error).includes('already exists but is not owned by this installation')) {
        throw error;
      }
      collision = error;
    }
  }
  throw new Error('platform: Could not allocate collision-free platform resource names.', {
    cause: collision,
  });
}

async function readAccounts(
  client: PlatformCloudflareClient,
): Promise<ReadonlyArray<CloudflareAccount>> {
  await client.verifyToken();
  const accounts = await client.listAccounts();
  if (accounts.length === 0) {
    throw new Error('platform: This Cloudflare token has no accessible accounts.');
  }
  return accounts;
}

async function selectAccount(
  accounts: ReadonlyArray<CloudflareAccount>,
  selector: string,
): Promise<string> {
  if (selector) {
    const matches = accounts.filter(
      (account) => account.id === selector || account.name.toLowerCase() === selector.toLowerCase(),
    );
    if (matches.length !== 1) {
      throw new Error(
        `platform: Cloudflare account ${JSON.stringify(selector)} is ambiguous or unavailable.`,
      );
    }
    return matches[0]!.id;
  }
  if (accounts.length === 1) {
    return accounts[0]!.id;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'platform: --account <id> is required when the token can access multiple accounts.',
    );
  }
  const value = await select({
    message: 'Cloudflare account:',
    options: accounts.map((account) => ({
      label: account.name,
      value: account.id,
      hint: account.id,
    })),
  });
  if (isCancel(value)) {
    throw new Error('platform: Cancelled.');
  }
  return String(value);
}

async function promptText(
  message: string,
  initialValue: string,
  optional = false,
): Promise<string> {
  if (!process.stdin.isTTY) {
    if (optional) {
      return '';
    }
    throw new Error(`platform: ${message.replace(/:$/, '')} is required in non-interactive mode.`);
  }
  const value = await text({
    message,
    initialValue,
    validate: optional ? undefined : (input) => (input ? undefined : 'A value is required.'),
  });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}

async function promptSecret(message: string, masked = true): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `platform: ${message.replace(/:$/, '')} is required in non-interactive mode. Set the documented VOID_PLATFORM_* environment variable.`,
    );
  }
  const value = masked
    ? await password({ message, validate: (input) => (input ? undefined : 'A value is required.') })
    : await text({ message, validate: (input) => (input ? undefined : 'A value is required.') });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}
