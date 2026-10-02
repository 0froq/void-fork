import { execFile } from 'node:child_process';
import type { PlatformDeploymentManifest } from '@void/platform';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { openBrowser } from './auth.ts';
import { pc } from './output.ts';
import type { PlatformManagementAccess } from './platform-auth.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

export type PlatformSetupPage = Readonly<{ title: string; url: string; instructions: string }>;

export function platformSetupLink(
  page: Pick<PlatformSetupPage, 'title' | 'url'>,
  hyperlinks: boolean = supportsSetupLinks(),
): string {
  return hyperlinks
    ? '\u001b]8;;' + page.url + '\u001b\\' + pc.underline(page.title) + '\u001b]8;;\u001b\\'
    : page.title + ': ' + pc.underline(page.url);
}

export function platformSetupFieldHelp(
  key: string,
): Readonly<{ description: string; placeholder?: string }> | undefined {
  const docs = (page: string, section: string, title: string) =>
    platformSetupLink({
      title,
      url: `https://void.cloud/guide/platform/installation/${page}#${section}`,
    });
  switch (key) {
    case 'databaseUrl':
      return {
        placeholder: 'postgresql://user:pw@…/database',
        description:
          'Provide a PostgreSQL database URL for platform users, projects, and deployments. Use an empty hosted database, e.g. ' +
          platformSetupLink({ title: 'Neon', url: 'https://neon.com/' }) +
          '. ' +
          docs('prerequisites', 'platform-database', 'Database setup'),
      };
    case 'jwtSecret':
      return {
        description:
          `Create a JWT signing key for platform login tokens. Run ${pc.blue('openssl rand -base64 32')}. Save the key in your password manager. ` +
          docs('credentials', 'signing-and-encryption-keys', 'Key setup'),
      };
    case 'projectSecretKey':
      return {
        description:
          `Generate a project encryption key for app secrets. Run ${pc.blue('openssl rand -base64 32')} separately. Save this key for recovery. ` +
          docs('credentials', 'signing-and-encryption-keys', 'Key setup'),
      };
    default:
      return undefined;
  }
}

function supportsSetupLinks(): boolean {
  return (
    !!process.stdout.isTTY &&
    (['ghostty', 'iTerm.app', 'WezTerm', 'vscode', 'WarpTerminal'].includes(
      process.env.TERM_PROGRAM ?? '',
    ) ||
      !!process.env.WT_SESSION ||
      !!process.env.VTE_VERSION ||
      !!process.env.KONSOLE_VERSION ||
      process.env.TERM === 'xterm-kitty')
  );
}

/** Dashboard keys use permission-catalog labels, which can differ from product names. */
function platformAccountTokenPermissions(includeAiGateway: boolean) {
  return [
    { key: 'account_settings', type: 'read' },
    { key: 'workers_scripts', type: 'edit' },
    { key: 'workers_kv_storage', type: 'edit' },
    { key: 'workers_r2', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'queues', type: 'edit' },
    { key: 'account_analytics', type: 'read' },
    { key: 'workers_tail', type: 'read' },
    { key: 'query_cache', type: 'edit' },
    ...(includeAiGateway ? [{ key: 'aig', type: 'edit' }] : []),
  ];
}

export function platformManagementSetupPage(
  plan: PlatformInstallPlan,
  options: { access?: PlatformManagementAccess | false } = {},
): PlatformSetupPage {
  const createsZone = plan.actions.some(
    (action) => action.kind === 'zone' && action.action === 'create',
  );
  const zoneName = plan.deployment.application.zoneName;
  const apiHostname = plan.deployment.controlPlane.apiHostname;
  const access =
    options.access ??
    (plan.deployment.authentication.accessProtection ||
    plan.deployment.authentication.providers.includes('cloudflare-access')
      ? { protection: !!plan.deployment.authentication.accessProtection, readOnly: false }
      : undefined);
  const accessLevel = access && access.readOnly ? 'read' : 'edit';
  const permissions = [
    ...platformAccountTokenPermissions(true),
    ...(zoneName || apiHostname || createsZone
      ? [
          { key: 'zone', type: createsZone ? 'edit' : 'read' },
          { key: 'dns', type: 'edit' },
          { key: 'workers_routes', type: 'edit' },
        ]
      : []),
    ...(access
      ? [
          { key: 'access', type: accessLevel },
          { key: 'access_acct', type: 'read' },
          ...(access.protection ? [{ key: 'access_service_token', type: accessLevel }] : []),
        ]
      : []),
    ...(zoneName && plan.deployment.application.baseDomain !== zoneName
      ? [{ key: 'ssl_and_certificates', type: 'read' }]
      : []),
  ];
  return {
    title: 'Cloudflare management API token',
    url:
      'https://dash.cloudflare.com/?' +
      new URLSearchParams({
        to: '/' + plan.account.id + '/api-tokens',
        name: plan.deployment.displayName + ' Management',
        permissionGroupKeys: JSON.stringify(permissions),
      }),
    instructions: [
      access
        ? `Browser login cannot configure Cloudflare Access${zoneName ? ' or change DNS' : ''}. This token lets the CLI install your platform.`
        : 'Browser login can preview DNS, but cannot change it. This token lets the CLI install your platform.',
      `Scope it to ${plan.account.name}${createsZone ? '; allow zone creation.' : zoneName ? ` and zone ${zoneName}.` : '.'}`,
      ...(apiHostname && apiHostname !== zoneName && !apiHostname.endsWith(`.${zoneName}`)
        ? [`Also include the zone for ${apiHostname}.`]
        : []),
      'Create the token with the preselected permissions, then paste it here.',
      ...(access
        ? [
            `Access: Apps and Policies ${accessLevel === 'edit' ? 'Edit' : 'Read'}, Organizations/Identity Providers/Groups Read${access.protection ? `, Service Tokens ${accessLevel === 'edit' ? 'Edit' : 'Read'}` : ''}.`,
          ]
        : []),
      'Permission checklist: ' +
        platformSetupLink({
          title: 'Void token permissions',
          url: 'https://void.cloud/guide/platform/installation/credentials#runtime-token-permissions',
        }),
    ].join('\n'),
  };
}

export function platformSetupPages(plan: PlatformInstallPlan): {
  runtime: PlatformSetupPage;
  github: PlatformSetupPage;
  r2: PlatformSetupPage;
} {
  const needsGateway = plan.actions.some(
    (action) => action.kind === 'ai-gateway' && action.action === 'inspect',
  );
  const permissions = [
    ...platformAccountTokenPermissions(needsGateway),
    ...(plan.deployment.application.zoneName ? [{ key: 'cache', type: 'purge' }] : []),
    ...(plan.deployment.capabilities.customDomains
      ? [{ key: 'ssl_and_certificates', type: 'edit' }]
      : []),
    // Email domain setup and destination consent use this token.
    ...(plan.deployment.capabilities.email
      ? [
          { key: 'zone', type: 'read' },
          { key: 'zone_settings', type: 'edit' },
          { key: 'email_routing_address', type: 'edit' },
          { key: 'email_routing_rule', type: 'edit' },
          { key: 'email_sending', type: 'edit' },
        ]
      : []),
  ];
  const query = new URLSearchParams({
    to: '/' + plan.account.id + '/api-tokens',
    name: plan.deployment.displayName + ' Runtime',
    permissionGroupKeys: JSON.stringify(permissions),
  });
  return {
    runtime: {
      title: 'Cloudflare runtime token',
      url: 'https://dash.cloudflare.com/?' + query,
      instructions: [
        'Review the preselected permissions for account ' + plan.account.name + '.',
        'Edit: Workers Scripts, KV, R2, D1, Queues, Hyperdrive' +
          (needsGateway ? ', AI Gateway.' : '.'),
        'Read: Account Settings, Account Analytics, Workers Tail.',
        ...(plan.deployment.application.zoneName
          ? ['Zone ' + plan.deployment.application.zoneName + ': Cache Purge: Purge.']
          : []),
        ...(plan.deployment.capabilities.customDomains
          ? ['Custom project domains also need SSL and Certificates: Edit on that zone.']
          : []),
        ...(plan.deployment.capabilities.email
          ? [
              'Email-enabled installations need Email Routing Addresses: Edit and Email Sending: Edit on the account, plus Zone: Read, Zone Settings: Edit and Email Routing Rules: Edit on the mail zones.',
            ]
          : []),
        'If the form differs, match the permissions above. Create the token, then paste it here.',
      ].join('\n'),
    },
    github: {
      title: 'GitHub OAuth App',
      url: 'https://github.com/settings/applications/new',
      instructions:
        'GitHub Auth will be used by the users of your Void Platform instance. Register a GitHub app and generate a client secret.\nHomepage: ' +
        plan.apiUrl +
        '\nRedirect URI: ' +
        plan.apiUrl +
        '/auth/callback',
    },
    r2: {
      title: 'R2 upload token',
      // R2's form accepts the token type but does not read permission/name
      // prefills. Open creation directly and make the remaining choice explicit.
      url:
        'https://dash.cloudflare.com/?' +
        new URLSearchParams({
          to: '/' + plan.account.id + '/r2/api-tokens/create',
          type: 'account',
        }),
      instructions: [
        'Select Object Read & Write.',
        'Keep Apply to all buckets in this account selected.',
        'Create the token, then copy the Access Key ID and Secret Access Key into the CLI.',
      ].join('\n'),
    },
  };
}

export function formatPlatformSetupPlan(
  plan: PlatformInstallPlan,
  options: { managementToken?: boolean; managementAccess?: boolean } = {},
): string {
  const writesDns = plan.actions.some(
    (action) =>
      (action.kind === 'zone' && action.action === 'create') ||
      (action.kind === 'dns-record' && action.action !== 'reuse'),
  );
  const credentials = [
    ...(options.managementToken
      ? [
          options.managementAccess
            ? `Cloudflare management API token for ${writesDns ? 'DNS changes and ' : ''}Access setup`
            : 'Cloudflare management API token for DNS changes',
        ]
      : []),
    'PostgreSQL database URL',
    'Cloudflare runtime token',
    'R2 upload token',
    ...(plan.deployment.authentication.providers.includes('github')
      ? ['GitHub OAuth App client ID and secret']
      : []),
    ...plan.deployment.authentication.providers
      .filter((provider) => provider !== 'github')
      .map(
        (provider) =>
          (provider === 'google'
            ? 'Google OAuth'
            : provider === 'oidc'
              ? 'OIDC'
              : 'Cloudflare Access OIDC') + ' client ID and secret',
      ),
    ...(plan.deployment.authentication.accessProtection
      ? ['Cloudflare Access application and installer credentials']
      : []),
    'JWT signing key and project encryption key',
  ];
  return [
    'The installation will guide you through setting up the following credentials:',
    '',
    ...credentials.map((credential) => `• ${credential}`),
  ].join('\n');
}

export type PlatformInstallCommandOptions = {
  commandName: 'void' | 'void-dev';
  accountId: string;
  installationSlug: string;
  displayName: string;
  applicationDomain: string;
  zoneName: string;
  controlPlaneDomain: string;
  dashboardUrl?: string;
  dedicatedZone: boolean;
  workersDev: boolean;
  authConfig?: string;
  authentication?: PlatformDeploymentManifest['authentication'];
  hyperdrive?: string;
  runtime: string;
  resumeId?: string;
  yes: boolean;
};

export function platformInstallCommandArguments(
  options: PlatformInstallCommandOptions,
): Array<string> {
  const parts = [options.commandName, 'platform', 'install'];
  const flag = (name: string, value: string) => {
    if (value) {
      parts.push(name, value);
    }
  };
  if (options.resumeId) {
    parts.push('--resume');
    flag('--name', options.resumeId);
  } else {
    flag('--name', options.installationSlug);
    flag('--account', options.accountId);
    flag('--display-name', options.displayName);
    if (options.workersDev) {
      parts.push('--workers-dev');
    } else {
      flag('--application-domain', options.applicationDomain);
      flag('--zone', options.zoneName);
      if (options.dedicatedZone) {
        parts.push('--dedicated-zone');
      } else {
        parts.push('--no-dedicated-zone');
      }
    }
    flag('--control-plane-domain', options.controlPlaneDomain);
    if (!options.controlPlaneDomain) {
      parts.push('--no-control-plane-domain');
    }
  }
  flag('--hyperdrive', options.hyperdrive ?? '');
  flag('--auth-config', options.authConfig ?? '');
  if (!options.authConfig && !options.resumeId && options.authentication) {
    flag('--login-methods', options.authentication.providers.join(','));
    parts.push(
      options.authentication.accessProtection ? '--access-protection' : '--no-access-protection',
    );
  }
  flag('--dashboard-url', options.dashboardUrl ?? '');
  flag('--runtime', options.runtime);
  if (options.yes) {
    parts.push('--yes');
  }
  return parts;
}

export function formatPlatformInstallCommand(options: PlatformInstallCommandOptions): string {
  return platformInstallCommandArguments(options)
    .map((value) => {
      if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
      }
      return process.platform === 'win32'
        ? `'${value.replaceAll("'", "''")}'`
        : `'${value.replaceAll("'", "'\\''")}'`;
    })
    .join(' ');
}

export function openPlatformSetupPage(
  page: PlatformSetupPage,
  dependencies: { interactive?: boolean; open?: (url: string) => void } = {},
): void {
  log.info(page.title + '\n' + page.instructions);
  console.log(platformSetupLink({ ...page, title: 'Open ' + page.title }));
  if (dependencies.interactive ?? process.stdin.isTTY === true) {
    try {
      (dependencies.open ?? ((url) => openBrowser(url, execFile)))(page.url);
    } catch {
      log.info('Could not open the browser. Use the link above.');
    }
  }
}
