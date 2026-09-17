import { execFile } from 'node:child_process';
import { log } from '@clack/prompts';
import { openBrowser } from './auth.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

export type PlatformSetupPage = Readonly<{ title: string; url: string; instructions: string }>;

export function platformSetupLink(
  page: PlatformSetupPage,
  hyperlinks: boolean = supportsSetupLinks(),
): string {
  return hyperlinks
    ? '\u001b]8;;' + page.url + '\u001b\\' + page.title + '\u001b]8;;\u001b\\'
    : page.title + ': ' + page.url;
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
export function platformSetupPages(plan: PlatformInstallPlan): {
  runtime: PlatformSetupPage;
  github: PlatformSetupPage;
  r2: PlatformSetupPage;
} {
  const needsGateway = plan.actions.some(
    (action) => action.kind === 'ai-gateway' && action.action === 'inspect',
  );
  const permissions = [
    { key: 'account_settings', type: 'read' },
    { key: 'workers_scripts', type: 'edit' },
    { key: 'workers_kv_storage', type: 'edit' },
    { key: 'workers_r2', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'queues', type: 'edit' },
    { key: 'account_analytics', type: 'read' },
    { key: 'workers_tail', type: 'read' },
    // Hyperdrive's catalog label is query_cache_write, not hyperdrive_write.
    { key: 'query_cache', type: 'edit' },
    // AI Gateway similarly uses aig_write in the permission catalog.
    ...(needsGateway ? [{ key: 'aig', type: 'edit' }] : []),
    ...(plan.deployment.application.zoneName ? [{ key: 'cache', type: 'purge' }] : []),
    ...(plan.deployment.capabilities.customDomains
      ? [{ key: 'ssl_and_certificates', type: 'edit' }]
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
      url:
        'https://dash.cloudflare.com/?' +
        new URLSearchParams({ to: '/' + plan.account.id + '/r2/api-tokens' }),
      instructions:
        'Choose Object Read & Write for this account, including future buckets. Copy the Access Key ID and Secret Access Key.',
    },
  };
}

export function formatPlatformSetupPlan(plan: PlatformInstallPlan): string {
  const pages = platformSetupPages(plan);
  // Keep URLs outside wrapping note boxes so terminal links remain intact.
  return [
    'Credentials needed (paste them into the installer; keep a password-manager copy):',
    platformSetupLink(pages.runtime),
    pages.runtime.instructions,
    '',
    platformSetupLink(pages.r2),
    pages.r2.instructions,
    '',
    platformSetupLink(pages.github),
    pages.github.instructions,
  ].join('\n');
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
