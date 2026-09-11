import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AssetConfig, HeaderRule, RedirectRule } from '@void/deploy-core';
import { applyEdits, modify } from 'jsonc-parser';

export type CloudflareStaticDeployConfig = Readonly<{
  configPath: string;
  name: string;
  accountId: string;
  main: string;
  assetsDirectory: string;
  compatibilityDate: string;
  assetConfig: AssetConfig;
}>;

/** Generate the deterministic thin Worker entry bundled by Wrangler. */
export function renderCloudflareStaticEntry(options: {
  headerRules?: ReadonlyArray<HeaderRule>;
  redirectRules?: ReadonlyArray<RedirectRule>;
  fallbackRules?: ReadonlyArray<RedirectRule>;
}): string {
  const config = JSON.stringify({
    ...(options.headerRules?.length ? { headerRules: options.headerRules } : {}),
    ...(options.redirectRules?.length ? { redirectRules: options.redirectRules } : {}),
    ...(options.fallbackRules?.length ? { fallbackRules: options.fallbackRules } : {}),
  });
  return [
    `import { createStaticEdgeHandler } from '@void/edge';`,
    `export default createStaticEdgeHandler(${config});`,
    '',
  ].join('\n');
}

/**
 * Persist the mutable Cloudflare target state without replacing comments,
 * Durable Object migrations, resource ids, or unrelated user configuration.
 */
export function writeCloudflareStaticDeployConfig(options: CloudflareStaticDeployConfig): boolean {
  const initial = existsSync(options.configPath)
    ? readFileSync(options.configPath, 'utf-8')
    : '{}\n';
  let content = initial;
  const upsert = (path: Array<string>, value: unknown): void => {
    const edits = modify(content, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    });
    content = applyEdits(content, edits);
  };

  upsert(['name'], options.name);
  upsert(['account_id'], options.accountId);
  upsert(['main'], options.main);
  upsert(['compatibility_date'], options.compatibilityDate);
  upsert(['assets', 'directory'], options.assetsDirectory);
  upsert(['assets', 'binding'], 'ASSETS');
  upsert(['assets', 'run_worker_first'], true);
  upsert(['assets', 'not_found_handling'], options.assetConfig.not_found_handling ?? 'none');
  upsert(['assets', 'html_handling'], options.assetConfig.html_handling ?? 'auto-trailing-slash');

  if (content === initial) {
    return false;
  }
  writeFileSync(options.configPath, content);
  return true;
}
