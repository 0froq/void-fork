import { confirm, intro, isCancel, log, note, outro, password, select, text } from '@clack/prompts';
import { normalizeApplicationDomain, normalizeInstallationSlug } from '@void/platform';
import { cliTitle } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import { PlatformCloudflareClient, type CloudflareAccount } from './platform-cloudflare.ts';
import {
  createPlatformInstallationSecrets,
  installPlatform,
  resolveBootstrapGitHubId,
} from './platform-installer.ts';
import { createPlatformInstallPlan, formatPlatformInstallPlan } from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  listInstallationManifests,
  readPendingInstallationSecrets,
  resolveInstallationManifest,
} from './platform-registry.ts';

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
    const collision = listInstallationManifests().find(
      (manifest) =>
        manifest.status !== 'uninstalled' &&
        manifest.deployment.installationSlug === installationSlug,
    );
    if (collision) {
      throw new Error(
        `platform: Installation ${collision.id} already uses this name. Resume it with \`void platform install --resume --name ${collision.id}\`.`,
      );
    }
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
    if (existing && !args.plan) {
      existing = resolveInstallationManifest(existing.id);
      const { verifyPlatformInstallationOwnership } = await import('./platform-management.ts');
      await verifyPlatformInstallationOwnership(client, existing);
    }
    const plan = await createPlatformInstallPlan(
      client,
      {
        accountId,
        applicationDomain,
        controlPlaneDomain,
        dedicatedZone,
        displayName,
        installationSlug,
        zoneName,
      },
      existing,
    );
    note(
      formatPlatformInstallPlan(plan),
      args.plan ? 'Read-only installation plan' : 'Installation plan',
    );
    if (args.plan) {
      outro('No Cloudflare or local installation state was changed.');
      return;
    }
    if (process.stdin.isTTY) {
      const proceed = await confirm({ message: 'Apply this plan?', initialValue: false });
      if (isCancel(proceed) || !proceed) {
        outro('No changes made.');
        return;
      }
    }

    const checkpoint = existing ? readPendingInstallationSecrets(existing) : null;
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
      databaseUrl:
        checkpoint?.databaseUrl ||
        process.env.VOID_PLATFORM_DATABASE_URL ||
        process.env.DATABASE_URL ||
        (await promptSecret('PostgreSQL DATABASE_URL:')),
      githubClientId:
        checkpoint?.githubClientId ||
        process.env.VOID_PLATFORM_GITHUB_CLIENT_ID ||
        (await promptSecret('GitHub OAuth client ID:', false)),
      githubClientSecret:
        checkpoint?.githubClientSecret ||
        process.env.VOID_PLATFORM_GITHUB_CLIENT_SECRET ||
        (await promptSecret('GitHub OAuth client secret:')),
      r2AccessKeyId:
        checkpoint?.r2AccessKeyId ||
        process.env.VOID_PLATFORM_R2_ACCESS_KEY_ID ||
        (await promptSecret('R2 access key ID:', false)),
      r2SecretAccessKey:
        checkpoint?.r2SecretAccessKey ||
        process.env.VOID_PLATFORM_R2_SECRET_ACCESS_KEY ||
        (await promptSecret('R2 secret access key:')),
    });
    const result = await installPlatform(plan, secrets, existing, { client });
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
